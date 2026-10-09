import {
  readBudgetedWorkspaceTextFile,
  refuseWorkspaceTextFileRead,
} from "../agent/tools/readWorkspaceTextFile.js";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../errors/appError.js";
import type { CachedPrDiffIndex } from "../review/placement/reviewDiffIndex.js";
import {
  createFffWorkspaceSearch,
  type WorkspaceFileSearchParams,
  type WorkspaceFileSearchResult,
} from "./fff/workspaceSearch.js";
import {
  LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
} from "../settings/index.js";
import {
  querySymbolIndex,
  symbolIndexStatus,
  type SymbolIndex,
  type SymbolIndexEntry,
  type SymbolIndexStatus,
} from "./symbolIndex.js";
import {
  assertPathAllowedForAsk,
  pathAllowedForAsk,
  isSensitivePath,
  type AskPathGate,
} from "../agent/ask/askSafety.js";
import {
  normalizeRepoRelativePath,
  isTriageControlPath,
} from "../agent/triage/triageWritePolicy.js";
const exec = promisify(execFile);
export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "other";
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

export type LocalPrChangedFile = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly oldPath?: string;
};

export type PinnedRepositoryReader = RepositoryReader & {
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
  readonly getBlameForPath: (path: string) => Promise<string>;
  readonly isPathInCheckout: (path: string) => boolean;
  readonly getCoverage: () => CheckoutCoverage;
  readonly noteSearchTruncated: () => void;
  readonly findFiles: (params: WorkspaceFileSearchParams) => Promise<WorkspaceFileSearchResult>;
  readonly lookupSymbol: (name: string, maxResults?: number) => readonly SymbolIndexEntry[];
  readonly getSymbolIndexStatus: () => SymbolIndexStatus;
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

export function assertWorkspacePath(root: string, requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "path_traversal",
      message: `Path traversal attempt detected: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "path_traversal",
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
      domain: "pr_workspace",
      kind: "symlink_escape",
      message: `Symlink escape blocked: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  const realRoot = await realpath(root);
  const realCandidate = await realpath(fullPath);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "symlink_escape",
      message: `Symlink escape blocked: ${requestedPath}`,
      context: { path: requestedPath },
    });
  }
  return fullPath;
}

export async function runWorkspaceGit(
  args: readonly string[],
  opts: {
    cwd: string;
    gitDir?: string;
    extraEnv?: Record<string, string>;
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
    ...(opts.gitDir ? { GIT_DIR: opts.gitDir } : {}),
    ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
    ...(opts.askpass ? { GIT_ASKPASS: opts.askpass, GIT_TOKEN_FILE: opts.tokenFile ?? "" } : {}),
    ...opts.extraEnv,
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
  workspace: { readonly privateGitDir: string; readonly agentCwd: string },
  params: GitGrepWorkspaceParams & { readonly timeoutMs: number },
  pathspecs: readonly string[],
): Promise<GitGrepChunkResult> {
  try {
    // Omit `--max-count`; some supported Git builds reject it. Result and byte caps stay after parse.
    const { stdout } = await runWorkspaceGit(
      ["grep", "-nF", "-I", "-z", "-e", params.query, "--", ...pathspecs],
      {
        cwd: workspace.privateGitDir,
        gitDir: workspace.privateGitDir,
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
  workspace: { readonly privateGitDir: string; readonly agentCwd: string },
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

export function createPinnedRepositoryReader(params: {
  readonly agentCwd: string;
  readonly privateGitDir: string;
  readonly headSha: string;
  readonly checkoutPaths: ReadonlySet<string>;
  readonly sortedCheckoutPaths: readonly string[];
  readonly checkoutMode: LocalPrWorkspaceCheckoutMode;
  readonly changedFiles: readonly LocalPrChangedFile[];
  readonly changedFileByPath: ReadonlyMap<string, LocalPrChangedFile>;
  readonly diffIndex: CachedPrDiffIndex;
  readonly stats: PinnedRepositoryReader["stats"];
  readonly patchByPath: ReadonlyMap<string, string>;
  readonly patchOmittedByCapPaths: ReadonlySet<string>;
  readonly symbolIndex: SymbolIndex | null;
}): { readonly reader: PinnedRepositoryReader; readonly dispose: () => void } {
  const {
    agentCwd,
    privateGitDir,
    headSha,
    checkoutPaths,
    sortedCheckoutPaths,
    checkoutMode,
    changedFiles,
    changedFileByPath,
    diffIndex,
    stats,
    patchByPath,
    patchOmittedByCapPaths,
  } = params;
  let symbolIndex = params.symbolIndex;
  const git = (args: readonly string[]) =>
    runWorkspaceGit(args, {
      cwd: privateGitDir,
      gitDir: privateGitDir,
      workTree: agentCwd,
      timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    });
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
        truncated: stats.truncated,
        warning: stats.warning,
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

  const fffSearch = createFffWorkspaceSearch({
    root: agentCwd,
    checkoutPaths,
    sortedCheckoutPaths,
    gitGrep: (grepParams) =>
      gitGrepWorkspace(
        { privateGitDir, agentCwd },
        { ...grepParams, timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS },
      ),
  });
  const grepLiteral = async (grepParams: GitGrepWorkspaceParams) => {
    const result = await fffSearch.search(grepParams);
    if (result.truncated) {
      noteSearchTruncated();
    }
    return result;
  };

  const lookupSymbol = (name: string, maxResults = LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS) =>
    querySymbolIndex(symbolIndex, name, maxResults);
  const getSymbolIndexStatus = () => symbolIndexStatus(symbolIndex);
  const reader: PinnedRepositoryReader = {
    ...filesystemReader(agentCwd),
    agentCwd,
    changedFiles,
    changedFileByPath,
    checkoutPaths,
    sortedCheckoutPaths,
    checkoutMode,
    diffIndex,
    stats,
    grepLiteral,
    getDiffForPath,
    getBlameForPath,
    isPathInCheckout,
    getCoverage,
    noteSearchTruncated,
    findFiles: fffSearch.findFiles,
    lookupSymbol,
    getSymbolIndexStatus,
  };
  return {
    reader,
    dispose: () => {
      symbolIndex = null;
      blameCache.clear();
      fffSearch.dispose();
    },
  };
}

/** The common read seam has pinned and mutable-checkout production adapters. */
export type RepositoryReader = {
  readonly agentCwd: string;
  readonly readSource: (path: string, maxFileBytes: number) => Promise<string | null>;
  readonly readFile: (
    path: string,
    policy: PathPolicy,
    opts: Parameters<typeof readBudgetedWorkspaceTextFile>[1],
  ) => ReturnType<typeof readBudgetedWorkspaceTextFile>;
  readonly refuseFile: (
    path: string,
    policy: PathPolicy,
    maxFileBytes: number,
  ) => ReturnType<typeof refuseWorkspaceTextFileRead>;
  readonly grepLiteral: (params: GitGrepWorkspaceParams) => Promise<GitGrepWorkspaceResult>;
  readonly getDiffForPath: (path: string) => Promise<string>;
};

/** Raw source decoding for navigation indexes, not delivered evidence. */
export async function readRepositorySource(
  root: string,
  path: string,
  maxFileBytes: number,
): Promise<string | null> {
  const safePath = assertWorkspacePath(root, path.replace(/\\/g, "/"));
  const info = await stat(safePath).catch(() => null);
  if (!info?.isFile() || info.size > maxFileBytes) return null;
  const buf = await readFile(safePath).catch(() => null);
  if (!buf || buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return null;
  return buf.toString("utf8");
}

function filesystemReader(
  root: string,
): Pick<RepositoryReader, "readSource" | "readFile" | "refuseFile"> {
  return {
    readSource: (path, maxFileBytes) => readRepositorySource(root, path, maxFileBytes),
    readFile: async (path, policy, opts) =>
      readBudgetedWorkspaceTextFile(await policy.resolveRead(path), opts),
    refuseFile: async (path, policy, maxFileBytes) =>
      refuseWorkspaceTextFileRead(await policy.resolveRead(path), maxFileBytes),
  };
}

export function createWritableRepositoryReader(root: string): RepositoryReader {
  return {
    ...filesystemReader(root),
    agentCwd: root,
    grepLiteral: (params) =>
      gitGrepWorkspace(
        { privateGitDir: resolve(root, ".git"), agentCwd: root },
        { ...params, timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS },
      ),
    getDiffForPath: async (path) => {
      const full = await assertContainedWorkspacePath(root, path);
      const rel = relative(root, full).replace(/\\/g, "/");
      const { stdout } = await runWorkspaceGit(["diff", "HEAD", "--", rel], {
        cwd: root,
        timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
      });
      return stdout;
    },
  };
}

export type PathPolicy = {
  readonly allows: (path: string) => boolean;
  readonly assertDiff: (path: string) => string;
  readonly resolveRead: (path: string) => Promise<string>;
  readonly allowsSearch: (path: string) => Promise<boolean>;
};

export function createPathPolicy(
  root: string,
  profile:
    | { readonly kind: "investigation"; readonly gate: AskPathGate }
    | { readonly kind: "verification" | "triage" },
): PathPolicy {
  const normalize = (path: string) =>
    profile.kind === "investigation" ? path.replace(/\\/g, "/") : normalizeRepoRelativePath(path);
  const allows = (path: string) => {
    if (profile.kind === "investigation") return pathAllowedForAsk(path, profile.gate);
    if (profile.kind === "triage") return !isTriageControlPath(normalize(path));
    return !isSensitivePath(normalize(path));
  };
  const assertDiff = (path: string) => {
    const normalized = normalize(path);
    if (profile.kind === "investigation") assertPathAllowedForAsk(normalized, profile.gate);
    else if (!allows(normalized))
      throw new AppError({
        domain: profile.kind,
        kind: "sensitive_path_blocked",
        message: `Blocked sensitive path "${normalized}"`,
        context: { path: normalized },
      });
    assertWorkspacePath(root, normalized);
    return normalized;
  };
  return {
    allows,
    assertDiff,
    resolveRead: async (path) =>
      profile.kind === "investigation"
        ? assertWorkspacePath(root, assertDiff(path))
        : assertContainedWorkspacePath(root, assertDiff(path)),
    allowsSearch: (path) =>
      profile.kind === "investigation"
        ? Promise.resolve(allows(path))
        : isTriageSearchPathAllowed(root, path),
  };
}
async function isAllowedTriageSearchPath(
  root: string,
  realRoot: string,
  path: string,
): Promise<boolean> {
  const normalized = normalizeRepoRelativePath(path);
  if (!normalized || isTriageControlPath(normalized)) return false;

  try {
    const fullPath = assertWorkspacePath(root, normalized);
    const realCandidate = await realpath(fullPath);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      return false;
    }
    const resolvedPath = normalizeRepoRelativePath(relative(realRoot, realCandidate));
    return !isTriageControlPath(resolvedPath);
  } catch {
    // A missing, malformed, or escaping result is not safe to expose. Git grep
    // should only return paths that resolve, so this is a defensive dead end.
    return false;
  }
}

export async function isTriageSearchPathAllowed(root: string, path: string): Promise<boolean> {
  return isAllowedTriageSearchPath(root, await realpath(root), path);
}
