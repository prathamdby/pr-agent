import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ListPullRequestFilesResult,
  PullRequestFileEntry,
} from "../github/listPullRequestFiles.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../review/placement/reviewDiffIndex.js";
import {
  LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE,
  LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY,
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS,
} from "../settings/index.js";
import { AppError } from "../errors/appError.js";
import {
  allocateWorkspaceResource,
  READONLY_WORKSPACE_ROOT_PREFIX,
  sweepStaleOwnedWorkspaces,
  type WorkspaceResource,
} from "./workspaceResource.js";
import {
  buildSymbolIndex,
  formatSymbolIndexStatusLine,
  isIndexableSourcePath,
  querySymbolIndex,
  symbolIndexStatus,
  type SymbolIndex,
  type SymbolIndexEntry,
  type SymbolIndexStatus,
} from "./symbolIndex.js";

const exec = promisify(execFile);
const BINARY_SAMPLE_BYTES = 8192;

export type { SymbolIndexEntry, SymbolIndexStatus };
export { formatSymbolIndexStatusLine };

const PRIVATE_CHECKOUT_DIR = "private";
const AGENT_TREE_DIR = "agent";
const PR_HEAD_REF = "pr-head";

type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "other";
export type LocalPrWorkspaceCheckoutMode = "full" | "sparse";

export type CheckoutCoverage = {
  readonly mode: "full" | "sparse";
  readonly pathsInCheckout: number;
  readonly changedFileCount: number;
  readonly changeSetTruncated: boolean;
  readonly searchTruncated?: boolean;
  readonly warning?: string;
};

export function buildCheckoutCoverage(workspace: {
  readonly checkoutMode: LocalPrWorkspaceCheckoutMode;
  readonly checkoutPaths: ReadonlySet<string>;
  readonly changedFiles: readonly { readonly path: string }[];
  readonly stats: {
    readonly truncated: boolean;
    readonly warning?: string;
  };
  readonly searchTruncated?: boolean;
}): CheckoutCoverage {
  return {
    mode: workspace.checkoutMode,
    pathsInCheckout: workspace.checkoutPaths.size,
    changedFileCount: workspace.changedFiles.length,
    changeSetTruncated: workspace.stats.truncated,
    ...(workspace.searchTruncated ? { searchTruncated: true } : {}),
    ...(workspace.stats.warning ? { warning: workspace.stats.warning } : {}),
  };
}

type LocalPrChangedFile = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly oldPath?: string;
};

export type LocalPrWorkspace = {
  readonly rootDir: string;
  readonly privateGitDir: string;
  readonly agentCwd: string;
  readonly changedFiles: readonly LocalPrChangedFile[];
  readonly changedFileByPath: ReadonlyMap<string, LocalPrChangedFile>;
  readonly checkoutPaths: ReadonlySet<string>;
  readonly sortedCheckoutPaths: readonly string[];
  readonly checkoutMode: LocalPrWorkspaceCheckoutMode;
  readonly diffIndex: CachedPrDiffIndex;
  readonly stats: {
    readonly truncated: boolean;
    readonly totalChanges: number;
    readonly fileCount: number;
    readonly warning?: string;
  };
  readonly grepLiteral: (params: GitGrepWorkspaceParams) => Promise<GitGrepWorkspaceResult>;
  readonly getDiffForPath: (path: string) => Promise<string>;
  readonly getBlameForPath: (path: string) => Promise<string>;
  readonly isPathInCheckout: (path: string) => boolean;
  readonly getCoverage: () => CheckoutCoverage;
  readonly noteSearchTruncated: () => void;
  readonly lookupSymbol: (name: string, maxResults?: number) => readonly SymbolIndexEntry[];
  readonly getSymbolIndexStatus: () => SymbolIndexStatus;
  readonly cleanup: () => Promise<void>;
};

export type GitGrepWorkspaceParams = {
  readonly query: string;
  readonly maxResults: number;
  readonly maxOutputBytes?: number;
  readonly paths?: readonly string[];
};

export type GitGrepWorkspaceResult = {
  readonly matches: readonly GitGrepWorkspaceMatch[];
  readonly truncated: boolean;
};

type GitGrepChunkResult = GitGrepWorkspaceResult & {
  readonly stdoutBytes: number;
};

type GitGrepWorkspaceMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

export type PrepareLocalPrWorkspaceParams = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationToken: string;
  readonly prFiles: ListPullRequestFilesResult;
  readonly repositorySizeKb?: number;
  readonly remoteUrlOverride?: string;
};

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new AppError({
      code: "pr_workspace.invalid_sha",
      message: `${field} must be a 40-character SHA`,
      context: { field },
    });
  }
}

function assertRepoPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new AppError({
      code: "pr_workspace.unsafe_repo_part",
      message: `${field} is not git-safe`,
      context: { field },
    });
  }
}

export function assertWorkspacePath(root: string, requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new AppError({
      code: "pr_workspace.path_traversal",
      message: `Path traversal attempt detected: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new AppError({
      code: "pr_workspace.path_traversal",
      message: `Path traversal attempt detected: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  return resolved;
}

/**
 * Ensure a repo-relative path stays inside root after symlink resolution.
 * Missing paths are allowed (caller decides); existing symlinks and escapes are denied.
 */
export async function assertContainedWorkspacePath(
  root: string,
  requestedPath: string,
): Promise<string> {
  const fullPath = assertWorkspacePath(root, requestedPath);
  const entry = await lstat(fullPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (entry == null) return fullPath;
  if (entry.isSymbolicLink()) {
    throw new AppError({
      code: "pr_workspace.symlink_escape",
      message: `Symlink escape blocked: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  const realRoot = await realpath(root);
  const realCandidate = await realpath(fullPath);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new AppError({
      code: "pr_workspace.symlink_escape",
      message: `Symlink escape blocked: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  return fullPath;
}

/** Remove symbolic links under a checkout tree. Skips `.git` so object stores stay intact. */
export async function stripWorkspaceSymlinks(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i += LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY).map(async (entry) => {
        if (entry.name === ".git") return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          await rm(full, { force: true });
          return;
        }
        if (entry.isDirectory()) {
          await stripWorkspaceSymlinks(full);
        }
      }),
    );
  }
}

function mapGithubStatus(file: PullRequestFileEntry): LocalPrChangedFile {
  const status = file.status;
  if (status === "renamed" && file.previousFilename) {
    return {
      path: file.filename,
      status: "renamed",
      oldPath: file.previousFilename,
    };
  }
  if (status === "copied" && file.previousFilename) {
    return {
      path: file.filename,
      status: "copied",
      oldPath: file.previousFilename,
    };
  }
  const mapped: ChangedFileStatus =
    status === "added"
      ? "added"
      : status === "removed"
        ? "deleted"
        : status === "modified" || status === "changed"
          ? "modified"
          : "other";
  return { path: file.filename, status: mapped };
}

export function selectLocalPrWorkspaceCheckoutMode(
  repositorySizeKb?: number,
): LocalPrWorkspaceCheckoutMode {
  return repositorySizeKb != null && repositorySizeKb > LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB
    ? "sparse"
    : "full";
}

async function execGit(
  args: readonly string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    tokenFile?: string;
    askpass?: string;
    workTree?: string;
    processCwd?: string;
    maxBufferBytes?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_DIR: opts.cwd,
    ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
    ...(opts.askpass ? { GIT_ASKPASS: opts.askpass, GIT_TOKEN_FILE: opts.tokenFile ?? "" } : {}),
  };
  return exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: opts.processCwd ?? opts.cwd,
    env,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferBytes ?? 20 * 1024 * 1024,
  });
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return error.code;
}

function errorStdout(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return "";
  return typeof error.stdout === "string" ? error.stdout : "";
}

function parseGitGrepOutput(stdout: string): GitGrepWorkspaceMatch[] {
  const matches: GitGrepWorkspaceMatch[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const pathEnd = stdout.indexOf("\0", offset);
    if (pathEnd < 0) break;
    const lineEnd = stdout.indexOf("\0", pathEnd + 1);
    if (lineEnd < 0) break;
    const textEnd = stdout.indexOf("\n", lineEnd + 1);
    const line = Number(stdout.slice(pathEnd + 1, lineEnd));
    const text = textEnd < 0 ? stdout.slice(lineEnd + 1) : stdout.slice(lineEnd + 1, textEnd);
    if (Number.isInteger(line) && line > 0) {
      matches.push({
        path: stdout.slice(offset, pathEnd),
        line,
        text,
      });
    }
    offset = textEnd < 0 ? stdout.length : textEnd + 1;
  }
  return matches;
}

function pathspecChunks(paths?: readonly string[]): string[][] {
  if (paths == null) return [["."]];
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE) {
    chunks.push(
      paths
        .slice(i, i + LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE)
        .map((path) => `:(literal)${path}`),
    );
  }
  return chunks;
}

async function gitGrepWorkspaceChunk(
  workspace: Pick<LocalPrWorkspace, "privateGitDir" | "agentCwd">,
  params: GitGrepWorkspaceParams & { readonly timeoutMs: number },
  pathspecs: readonly string[],
): Promise<GitGrepChunkResult> {
  try {
    // Omit `--max-count`; some supported Git builds reject it. Result and byte caps stay after parse.
    const { stdout } = await execGit(
      [
        "grep",
        "-nF",
        "-I",
        "-z",
        "-e",
        params.query,
        "--",
        ...pathspecs,
      ],
      {
        cwd: workspace.privateGitDir,
        timeoutMs: params.timeoutMs,
        workTree: workspace.agentCwd,
        processCwd: workspace.agentCwd,
        maxBufferBytes: params.maxOutputBytes,
      },
    );
    return {
      matches: parseGitGrepOutput(stdout),
      truncated: false,
      stdoutBytes: Buffer.byteLength(stdout),
    };
  } catch (error) {
    if (errorCode(error) === 1) return { matches: [], truncated: false, stdoutBytes: 0 };
    if (errorCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      const stdout = errorStdout(error);
      return {
        matches: parseGitGrepOutput(stdout),
        truncated: true,
        stdoutBytes: Buffer.byteLength(stdout),
      };
    }
    throw error;
  }
}

export async function gitGrepWorkspace(
  workspace: Pick<LocalPrWorkspace, "privateGitDir" | "agentCwd">,
  params: GitGrepWorkspaceParams & { readonly timeoutMs: number },
): Promise<GitGrepWorkspaceResult> {
  if (params.paths?.length === 0) return { matches: [], truncated: false };
  const matches: GitGrepWorkspaceMatch[] = [];
  let truncated = false;
  let outputBytes = 0;
  for (const pathspecs of pathspecChunks(params.paths)) {
    const remainingBytes =
      params.maxOutputBytes == null ? undefined : Math.max(params.maxOutputBytes - outputBytes, 1);
    const result = await gitGrepWorkspaceChunk(
      workspace,
      { ...params, maxOutputBytes: remainingBytes },
      pathspecs,
    );
    outputBytes += result.stdoutBytes;
    matches.push(...result.matches);
    if (
      result.truncated ||
      matches.length > params.maxResults ||
      (params.maxOutputBytes != null && outputBytes >= params.maxOutputBytes)
    ) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

async function ensureFreeSpace(dir: string, minBytes: number): Promise<void> {
  const fs = await statfs(dir);
  const freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize);
  if (freeBytes < BigInt(minBytes)) {
    throw new AppError({
      code: "pr_workspace.insufficient_free_space",
      message: "Insufficient free space for local PR workspace",
      context: { minBytes },
    });
  }
}

async function ensureWorkspaceMinFreeSpace(dir: string, minBytes: number): Promise<void> {
  try {
    await ensureFreeSpace(dir, minBytes);
  } catch (error) {
    if (!(error instanceof AppError && error.code === "pr_workspace.insufficient_free_space")) {
      throw error;
    }
    await cleanupStaleLocalPrWorkspaces();
    await ensureFreeSpace(dir, minBytes);
  }
}

function gitObjectStoreBytes(countObjectsOutput: string): number {
  let sizeKiB = 0;
  let sizePackKiB = 0;
  for (const line of countObjectsOutput.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = Number(line.slice(colon + 1).trim());
    if (Number.isNaN(value)) continue;
    if (key === "size") sizeKiB = value;
    if (key === "size-pack") sizePackKiB = value;
  }
  return (sizeKiB + sizePackKiB) * 1024;
}

async function enforceMaxFetchBytes(
  git: (args: readonly string[], timeoutMs?: number) => Promise<{ stdout: string }>,
  maxFetchBytes: number,
  timeoutMs: number,
): Promise<void> {
  const { stdout: countObjectsOut } = await git(["count-objects", "-v"], timeoutMs);
  const objectStoreBytes = gitObjectStoreBytes(countObjectsOut);
  if (objectStoreBytes > maxFetchBytes) {
    throw new AppError({
      code: "pr_workspace.fetch_too_large",
      message: `PR fetch object store (${objectStoreBytes} bytes) exceeds LOCAL_WORKSPACE_MAX_FETCH_BYTES (${maxFetchBytes})`,
      context: { objectStoreBytes, maxFetchBytes },
    });
  }
}

async function prepareCheckedOutTree(dir: string, prefix = ""): Promise<Set<string>> {
  const paths = new Set<string>();
  const entries = await readdir(dir, { withFileTypes: true });

  for (let i = 0; i < entries.length; i += LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY).map(async (entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          await rm(full, { force: true });
          return;
        }
        if (entry.isDirectory()) {
          const childPaths = await prepareCheckedOutTree(full, rel);
          for (const path of childPaths) paths.add(path);
          return;
        }
        if (entry.isFile()) {
          paths.add(rel.replace(/\\/g, "/"));
        }
        await chmod(full, 0o444);
      }),
    );
  }
  await chmod(dir, 0o555);
  return paths;
}

function sparseCheckoutPattern(path: string): string {
  return `/${path.replace(/\\/g, "/").replace(/[\\*?[]/g, "\\$&")}`;
}

function sparseCheckoutPatterns(changedFiles: readonly LocalPrChangedFile[]): string {
  const paths = changedFiles
    .filter((file) => file.status !== "deleted")
    .map((file) => sparseCheckoutPattern(file.path));
  return paths.length > 0 ? `${paths.join("\n")}\n` : "";
}

const PI_AGENT_DIR_PREFIX = "pr-agent-pi-";

export {
  registerLiveLocalPrWorkspace,
  unregisterLiveLocalPrWorkspace,
} from "./workspaceResource.js";

async function cleanupStalePiAgentDirs(): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PI_AGENT_DIR_PREFIX)) continue;
    const full = join(tmpdir(), entry.name);
    const entryStat = await statIfPresent(full);
    if (!entryStat) continue;
    const ageMs = now - entryStat.mtimeMs;
    if (ageMs > LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS * 1000) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function statIfPresent(path: string) {
  return stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

export async function cleanupStaleLocalPrWorkspaces(): Promise<void> {
  await cleanupStalePiAgentDirs();
  await sweepStaleOwnedWorkspaces();
}

export async function prepareLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
): Promise<LocalPrWorkspace> {
  const { owner, repo, headSha, installationToken } = params;
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repo");
  assertSha(headSha, "headSha");
  await ensureWorkspaceMinFreeSpace(tmpdir(), LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES);

  const resource = await allocateWorkspaceResource({
    prefix: READONLY_WORKSPACE_ROOT_PREFIX,
    installationToken,
  });
  try {
    return await finishLocalPrWorkspace(params, resource);
  } catch (error) {
    await resource.release();
    throw error;
  }
}

async function finishLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
  resource: WorkspaceResource,
): Promise<LocalPrWorkspace> {
  const { owner, repo, prNumber, headSha, prFiles } = params;
  const rootDir = resource.rootDir;
  const credentials = resource.credentials;
  const privateGitDir = join(rootDir, PRIVATE_CHECKOUT_DIR);
  const agentCwd = join(rootDir, AGENT_TREE_DIR);
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const changedFiles = prFiles.files.map(mapGithubStatus);
  const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const checkoutMode = selectLocalPrWorkspaceCheckoutMode(params.repositorySizeKb);
  const diffIndex = createCachedPrDiffIndex();
  const patchByPath = new Map<string, string>();
  const patchOmittedByCapPaths = new Set<string>();
  const filesForIndex = [];
  for (const file of prFiles.files) {
    const patch = file.patch ?? "";
    if (file.patchOmitted) {
      patchOmittedByCapPaths.add(file.filename);
    } else if (patch.length > 0) {
      patchByPath.set(file.filename, patch);
    }
    filesForIndex.push({
      filename: file.filename,
      patch: file.patchOmitted || !file.patch ? undefined : file.patch,
      patchOmitted: file.patchOmitted === true || file.patch == null || file.patch === "",
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  ingestListPullRequestFilesResult(diffIndex, {
    truncated: prFiles.truncated,
    files: filesForIndex,
  });

  const git = (args: readonly string[], timeoutMs = LOCAL_WORKSPACE_FETCH_TIMEOUT_MS) =>
    execGit(args, {
      cwd: privateGitDir,
      timeoutMs,
      tokenFile: credentials.tokenFile,
      askpass: credentials.askpass,
      workTree: agentCwd,
    });

  let checkoutPaths = new Set<string>();
  let sortedCheckoutPaths: string[] = [];
  let searchTruncated = false;
  const blameCache = new Map<string, Promise<string>>();

  function isPathInCheckout(path: string): boolean {
    return checkoutPaths.has(path.replace(/\\/g, "/"));
  }

  function getCoverage(): CheckoutCoverage {
    return buildCheckoutCoverage({
      checkoutMode,
      checkoutPaths,
      changedFiles,
      stats: {
        truncated: prFiles.truncated,
        warning: prFiles.warning,
      },
      searchTruncated,
    });
  }

  function noteSearchTruncated(): void {
    searchTruncated = true;
  }

  async function getDiffForPath(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, "/");
    const patch = patchByPath.get(normalized);
    if (patch == null) {
      if (patchOmittedByCapPaths.has(normalized)) {
        return "[patch omitted: exceeds configured PR patch byte cap]";
      }
      return "";
    }
    return patch.length > LOCAL_WORKSPACE_MAX_DIFF_BYTES
      ? `${patch.slice(0, LOCAL_WORKSPACE_MAX_DIFF_BYTES)}\n...[diff truncated]`
      : patch;
  }

  async function getBlameForPath(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, "/");
    const changed = changedFileByPath.get(normalized);
    if (changed?.status === "deleted") {
      return "";
    }
    if (!isPathInCheckout(normalized)) {
      return "";
    }
    // Blame is immutable at this workspace's pinned headSha, and the four
    // specialists routinely blame the same path: one git process per path.
    const cached = blameCache.get(normalized);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const { stdout } = await git(["blame", "--line-porcelain", headSha, "--", normalized]);
      return stdout.length > LOCAL_WORKSPACE_MAX_DIFF_BYTES
        ? `${stdout.slice(0, LOCAL_WORKSPACE_MAX_DIFF_BYTES)}\n...[blame truncated]`
        : stdout;
    })();
    blameCache.set(normalized, pending);
    try {
      return await pending;
    } catch (error) {
      if (blameCache.get(normalized) === pending) blameCache.delete(normalized);
      throw error;
    }
  }

  const grepLiteral = async (grepParams: GitGrepWorkspaceParams) => {
    const result = await gitGrepWorkspace(
      { privateGitDir, agentCwd },
      { ...grepParams, timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS },
    );
    if (result.truncated) {
      noteSearchTruncated();
    }
    return result;
  };

  await mkdir(privateGitDir, { recursive: true });
  await mkdir(agentCwd, { recursive: true });
  await git(["init"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
  await git(["remote", "add", "origin", remoteUrl], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
  const prRef = `+refs/pull/${prNumber}/head:refs/heads/${PR_HEAD_REF}`;
  const fetchArgs = [
    "fetch",
    "--no-tags",
    "--depth=1",
    ...(checkoutMode === "sparse" ? ["--filter=blob:none"] : []),
    "--no-recurse-submodules",
    "origin",
    prRef,
  ];
  await git(fetchArgs, LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
  if (checkoutMode === "sparse") {
    await git(["config", "core.sparseCheckout", "true"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(["config", "core.sparseCheckoutCone", "false"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await writeFile(
      join(privateGitDir, "info", "sparse-checkout"),
      sparseCheckoutPatterns(changedFiles),
    );
  }
  await git(["checkout", "-f", PR_HEAD_REF], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
  await enforceMaxFetchBytes(
    git,
    LOCAL_WORKSPACE_MAX_FETCH_BYTES,
    LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  );
  const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
  if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
    throw new AppError({
      code: "pr_workspace.head_sha_mismatch",
      message: `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
      context: { fetchedHead: fetchedHead.trim(), headSha },
    });
  }

  await credentials.cleanup();
  checkoutPaths = await prepareCheckedOutTree(agentCwd);
  sortedCheckoutPaths = [...checkoutPaths].toSorted();

  let symbolIndex: SymbolIndex | null = null;

  async function readIndexableFile(path: string): Promise<string | null> {
    const normalized = path.replace(/\\/g, "/");
    if (!isPathInCheckout(normalized) || !isIndexableSourcePath(normalized)) return null;
    const safePath = assertWorkspacePath(agentCwd, normalized);
    const info = await stat(safePath).catch(() => null);
    if (!info?.isFile() || info.size > LOCAL_WORKSPACE_MAX_FILE_BYTES) return null;
    const buf = await readFile(safePath).catch(() => null);
    if (!buf) return null;
    if (buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)).includes(0)) return null;
    return buf.toString("utf8");
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS,
    );
    try {
      symbolIndex = await buildSymbolIndex(
        sortedCheckoutPaths.filter(isIndexableSourcePath),
        readIndexableFile,
        {
          maxSymbols: LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS,
          maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
          signal: controller.signal,
        },
      );
    } catch {
      symbolIndex = null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    symbolIndex = null;
  }

  const lookupSymbol = (name: string, maxResults = LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS) =>
    querySymbolIndex(symbolIndex, name, maxResults);

  const getSymbolIndexStatus = () => symbolIndexStatus(symbolIndex);

  return {
    rootDir,
    privateGitDir,
    agentCwd,
    changedFiles,
    changedFileByPath,
    checkoutPaths,
    sortedCheckoutPaths,
    checkoutMode,
    diffIndex,
    stats: {
      truncated: prFiles.truncated,
      totalChanges: prFiles.totalChanges,
      fileCount: changedFiles.length,
      warning: prFiles.warning,
    },
    grepLiteral,
    getDiffForPath,
    getBlameForPath,
    isPathInCheckout,
    getCoverage,
    noteSearchTruncated,
    lookupSymbol,
    getSymbolIndexStatus,
    cleanup: async () => {
      symbolIndex = null;
      blameCache.clear();
      await resource.release();
    },
  };
}
