import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
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
} from "../settings/index.js";
import { createGitCredentialFiles, makeDirectoriesWritable } from "./gitCredentials.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT_PREFIX = "pr-agent-workspace-";
const TRIAGE_WORKSPACE_ROOT_PREFIX = "pr-agent-triage-";
const PRIVATE_CHECKOUT_DIR = "private";
const AGENT_TREE_DIR = "agent";
const PR_HEAD_REF = "pr-head";

type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "other";
export type LocalPrWorkspaceCheckoutMode = "full" | "sparse";

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

export type GitGrepWorkspaceMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

export type PrepareLocalPrWorkspaceParams = {
  readonly cfg: Config;
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
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a 40-character SHA`);
}

function assertRepoPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${field} is not git-safe`);
}

export function assertWorkspacePath(root: string, requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Path traversal attempt detected: ${requestedPath}`);
  }
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error(`Path traversal attempt detected: ${requestedPath}`);
  }
  return resolved;
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
  cfg: Pick<Config, "localWorkspaceFullCloneMaxRepoKb">,
  repositorySizeKb?: number,
): LocalPrWorkspaceCheckoutMode {
  return repositorySizeKb != null && repositorySizeKb > cfg.localWorkspaceFullCloneMaxRepoKb
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

function failedWithExitCode(error: unknown, code: number): boolean {
  return errorCode(error) === code;
}

function failedWithMaxBuffer(error: unknown): boolean {
  return errorCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
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

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function pathspecChunks(paths?: readonly string[]): string[][] {
  if (paths == null) return [["."]];
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE) {
    chunks.push(paths.slice(i, i + LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE).map(literalPathspec));
  }
  return chunks;
}

async function gitGrepWorkspaceChunk(
  workspace: Pick<LocalPrWorkspace, "privateGitDir" | "agentCwd">,
  params: GitGrepWorkspaceParams & { readonly timeoutMs: number },
  pathspecs: readonly string[],
): Promise<GitGrepChunkResult> {
  try {
    const { stdout } = await execGit(
      [
        "grep",
        "-nF",
        "-I",
        "-z",
        `--max-count=${params.maxResults + 1}`,
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
    if (failedWithExitCode(error, 1)) return { matches: [], truncated: false, stdoutBytes: 0 };
    if (failedWithMaxBuffer(error)) {
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
    throw new Error("Insufficient free space for local PR workspace");
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
    throw new Error(
      `PR fetch object store (${objectStoreBytes} bytes) exceeds LOCAL_WORKSPACE_MAX_FETCH_BYTES (${maxFetchBytes})`,
    );
  }
}

async function removeWorkspace(rootDir: string): Promise<void> {
  await makeDirectoriesWritable(rootDir);
  await rm(rootDir, { recursive: true, force: true });
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

async function cleanupStalePiAgentDirs(cfg: Config): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PI_AGENT_DIR_PREFIX)) continue;
    const full = join(tmpdir(), entry.name);
    const ageMs = now - (await stat(full)).mtimeMs;
    if (ageMs > cfg.localWorkspaceStaleCleanupAgeSeconds * 1000) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function cleanupStaleLocalPrWorkspaces(cfg: Config): Promise<void> {
  await cleanupStalePiAgentDirs(cfg);
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      (!entry.name.startsWith(WORKSPACE_ROOT_PREFIX) &&
        !entry.name.startsWith(TRIAGE_WORKSPACE_ROOT_PREFIX))
    ) {
      continue;
    }
    const full = join(tmpdir(), entry.name);
    const ageMs = now - (await stat(full)).mtimeMs;
    if (ageMs > cfg.localWorkspaceStaleCleanupAgeSeconds * 1000) {
      await removeWorkspace(full).catch(() => undefined);
    }
  }
}

export async function prepareLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
): Promise<LocalPrWorkspace> {
  const { cfg, owner, repo, prNumber, headSha, installationToken, prFiles } = params;
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repo");
  assertSha(headSha, "headSha");
  await ensureFreeSpace(tmpdir(), cfg.localWorkspaceMinFreeSpaceBytes);

  const rootDir = await mkdtemp(join(tmpdir(), WORKSPACE_ROOT_PREFIX));
  const privateGitDir = join(rootDir, PRIVATE_CHECKOUT_DIR);
  const agentCwd = join(rootDir, AGENT_TREE_DIR);
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const credentials = await createGitCredentialFiles(rootDir, installationToken);
  const changedFiles = prFiles.files.map(mapGithubStatus);
  const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const checkoutMode = selectLocalPrWorkspaceCheckoutMode(cfg, params.repositorySizeKb);
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

  const git = (args: readonly string[], timeoutMs = cfg.localWorkspaceFetchTimeoutMs) =>
    execGit(args, {
      cwd: privateGitDir,
      timeoutMs,
      tokenFile: credentials.tokenFile,
      askpass: credentials.askpass,
      workTree: agentCwd,
    });

  let checkoutPaths = new Set<string>();
  let sortedCheckoutPaths: string[] = [];

  function isPathInCheckout(path: string): boolean {
    return checkoutPaths.has(path.replace(/\\/g, "/"));
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
    return patch.length > cfg.localWorkspaceMaxDiffBytes
      ? `${patch.slice(0, cfg.localWorkspaceMaxDiffBytes)}\n...[diff truncated]`
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
    const { stdout } = await git(["blame", "--line-porcelain", headSha, "--", normalized]);
    return stdout.length > cfg.localWorkspaceMaxDiffBytes
      ? `${stdout.slice(0, cfg.localWorkspaceMaxDiffBytes)}\n...[blame truncated]`
      : stdout;
  }

  const grepLiteral = (grepParams: GitGrepWorkspaceParams) =>
    gitGrepWorkspace(
      { privateGitDir, agentCwd },
      { ...grepParams, timeoutMs: cfg.localWorkspaceFetchTimeoutMs },
    );

  try {
    await mkdir(privateGitDir, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await git(["init"], cfg.localWorkspaceCloneTimeoutMs);
    await git(["remote", "add", "origin", remoteUrl], cfg.localWorkspaceCloneTimeoutMs);
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
    await git(fetchArgs, cfg.localWorkspaceFetchTimeoutMs);
    if (checkoutMode === "sparse") {
      await git(["config", "core.sparseCheckout", "true"], cfg.localWorkspaceCloneTimeoutMs);
      await git(["config", "core.sparseCheckoutCone", "false"], cfg.localWorkspaceCloneTimeoutMs);
      await writeFile(
        join(privateGitDir, "info", "sparse-checkout"),
        sparseCheckoutPatterns(changedFiles),
      );
    }
    await git(["checkout", "-f", PR_HEAD_REF], cfg.localWorkspaceCloneTimeoutMs);
    await enforceMaxFetchBytes(
      git,
      cfg.localWorkspaceMaxFetchBytes,
      cfg.localWorkspaceFetchTimeoutMs,
    );
    const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
    if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
      throw new Error(
        `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
      );
    }

    await credentials.cleanup();
    checkoutPaths = await prepareCheckedOutTree(agentCwd);
    sortedCheckoutPaths = [...checkoutPaths].toSorted();

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
      cleanup: () => removeWorkspace(rootDir),
    };
  } catch (e) {
    await removeWorkspace(rootDir).catch(() => undefined);
    throw e;
  }
}
