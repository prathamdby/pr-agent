import {
  readBudgetedWorkspaceTextFile,
  refuseWorkspaceTextFileRead,
} from "../agent/tools/readWorkspaceTextFile.ts";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { AppError, isAppError } from "../errors/appError.ts";
import { redactOutboundSecrets } from "../security/redactOutboundSecrets.ts";
import { runGitProcess, type GitProcessResult } from "./gitProcess.ts";
import type { CachedPrDiffIndex } from "./reviewDiffIndex.ts";
import {
  createFffWorkspaceSearch,
  type WorkspaceFileSearchParams,
  type WorkspaceFileSearchResult,
} from "./fff/workspaceSearch.ts";
import {
  LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_GIT_MAX_BUFFER_BYTES,
  LOCAL_WORKSPACE_GIT_STDERR_DIAGNOSTIC_CHARS,
  LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
} from "../settings/index.ts";
import {
  querySymbolIndex,
  symbolIndexStatus,
  type SymbolIndex,
  type SymbolIndexEntry,
  type SymbolIndexStatus,
} from "./symbolIndex.ts";

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

const PATCH_BYTE_CAP_DIFF = "[patch omitted: exceeds configured PR patch byte cap]";

export type WorkspacePathDiff =
  | {
      readonly availability: "available";
      readonly reason: null | "workspace_diff_byte_cap";
      readonly diff: string;
    }
  | {
      readonly availability: "unchanged";
      readonly reason: "absent_from_complete_change_set" | "matches_head";
      readonly diff: "";
    }
  | {
      readonly availability: "unavailable";
      readonly reason: "upstream_patch_missing" | "upstream_patch_empty" | "change_set_truncated";
      readonly diff: "";
    }
  | {
      readonly availability: "unavailable";
      readonly reason: "patch_byte_cap";
      readonly diff: typeof PATCH_BYTE_CAP_DIFF;
    }
  | {
      readonly availability: "unavailable";
      readonly reason: "rename_previous_path";
      readonly diff: "";
      readonly currentPath: string;
    };

function classifyPinnedPrDiff(input: {
  readonly path: string;
  readonly changedFileByPath: ReadonlyMap<string, LocalPrChangedFile>;
  readonly changedFiles: readonly LocalPrChangedFile[];
  readonly patchByPath: ReadonlyMap<string, string>;
  readonly patchOmittedByCapPaths: ReadonlySet<string>;
  readonly truncated: boolean;
}): WorkspacePathDiff {
  const normalized = input.path.replace(/\\/g, "/");
  if (input.changedFileByPath.has(normalized)) {
    if (input.patchOmittedByCapPaths.has(normalized)) {
      return { availability: "unavailable", reason: "patch_byte_cap", diff: PATCH_BYTE_CAP_DIFF };
    }
    const patch = input.patchByPath.get(normalized);
    if (patch == null) {
      return { availability: "unavailable", reason: "upstream_patch_missing", diff: "" };
    }
    if (patch.length === 0) {
      return { availability: "unavailable", reason: "upstream_patch_empty", diff: "" };
    }
    if (patch.length > LOCAL_WORKSPACE_MAX_DIFF_BYTES) {
      return {
        availability: "available",
        reason: "workspace_diff_byte_cap",
        diff: `${patch.slice(0, LOCAL_WORKSPACE_MAX_DIFF_BYTES)}\n...[diff truncated]`,
      };
    }
    return { availability: "available", reason: null, diff: patch };
  }
  const renamed = input.changedFiles.find(
    (file) => file.status === "renamed" && file.oldPath === normalized,
  );
  if (renamed) {
    return {
      availability: "unavailable",
      reason: "rename_previous_path",
      diff: "",
      currentPath: renamed.path,
    };
  }
  if (input.truncated) {
    return { availability: "unavailable", reason: "change_set_truncated", diff: "" };
  }
  return {
    availability: "unchanged",
    reason: "absent_from_complete_change_set",
    diff: "",
  };
}

export type PinnedRepositoryReader = RepositoryReader & {
  readonly headSha: string;
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

export type WorkspaceGitOperation = (typeof WORKSPACE_GIT_OPERATIONS)[number] | "other";

export type WorkspaceGitFailureKind = "timeout" | "auth" | "missing_ref" | "git";

export type WorkspaceGitTimeoutSource = "process_timer" | "git_low_speed";

export type WorkspaceGitOptions = {
  cwd: string;
  gitDir?: string;
  extraEnv?: Record<string, string>;
  stdin?: Buffer | string;
  timeoutMs: number;
  tokenFile?: string;
  askpass?: string;
  workTree?: string;
  processCwd?: string;
  maxBufferBytes?: number;
  checkoutMode?: LocalPrWorkspaceCheckoutMode;
  redactSecrets?: readonly string[];
};

export type WorkspaceGitDiagnostics = {
  readonly operation: WorkspaceGitOperation;
  readonly checkoutMode: LocalPrWorkspaceCheckoutMode | null;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly timeoutSource: WorkspaceGitTimeoutSource | null;
};

const WORKSPACE_GIT_OPERATIONS = [
  "add",
  "blame",
  "checkout",
  "commit",
  "config",
  "count-objects",
  "diff",
  "fetch",
  "grep",
  "init",
  "push",
  "remote",
  "reset",
  "rev-parse",
  "status",
] as const;

const GIT_LOW_SPEED_PATTERN = /Operation too slow|Operation timed out|curl 28\b/i;
const GIT_AUTH_PATTERN =
  /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or password|returned error: 40[13]\b|Permission denied \(publickey|Write access to repository not granted|repository '[^']*' not found/i;
const GIT_MISSING_REF_PATTERN =
  /couldn't find remote ref|no such remote ref|fatal: invalid refspec|not our ref|unadvertised object/i;
const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
const MIN_REDACTED_SECRET_LENGTH = 4;

function workspaceGitOperation(args: readonly string[]): WorkspaceGitOperation {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-c" || arg === "-C") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return WORKSPACE_GIT_OPERATIONS.find((operation) => operation === arg) ?? "other";
  }
  return "other";
}

function redactGitText(text: string, secrets: readonly string[]): string {
  let out = text.split("\0").join("");
  for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) {
    if (secret.length < MIN_REDACTED_SECRET_LENGTH) continue;
    out = out.split(secret).join("[redacted]");
  }
  return redactOutboundSecrets(out.replace(CREDENTIAL_URL_PATTERN, "$1[redacted]@"));
}

function completeLines(text: string): string {
  const end = text.lastIndexOf("\n");
  return end < 0 ? "" : text.slice(0, end + 1);
}

function stderrDiagnostic(stderr: string): string {
  if (stderr.length <= LOCAL_WORKSPACE_GIT_STDERR_DIAGNOSTIC_CHARS) return stderr.trimEnd();
  const window = stderr.slice(-LOCAL_WORKSPACE_GIT_STDERR_DIAGNOSTIC_CHARS);
  const lineStart = window.indexOf("\n");
  return (lineStart < 0 ? "" : window.slice(lineStart + 1)).trimEnd();
}

function gitFailureKind(result: GitProcessResult, stderr: string): WorkspaceGitFailureKind {
  if (result.timedOut) return "timeout";
  if (result.spawnErrorCode != null || result.outputLimited) return "git";
  if (GIT_LOW_SPEED_PATTERN.test(stderr)) return "timeout";
  if (GIT_AUTH_PATTERN.test(stderr)) return "auth";
  if (GIT_MISSING_REF_PATTERN.test(stderr)) return "missing_ref";
  return "git";
}

function gitTimeoutSource(
  result: GitProcessResult,
  failureKind: WorkspaceGitFailureKind,
): WorkspaceGitTimeoutSource | null {
  if (failureKind !== "timeout") return null;
  return result.timedOut ? "process_timer" : "git_low_speed";
}

function gitDiagnostics(
  result: GitProcessResult,
  operation: WorkspaceGitOperation,
  opts: Pick<WorkspaceGitOptions, "checkoutMode">,
  timeoutSource: WorkspaceGitTimeoutSource | null,
): WorkspaceGitDiagnostics {
  return {
    operation,
    checkoutMode: opts.checkoutMode ?? null,
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode,
    signal: result.signal,
    killed: result.killed,
    timeoutSource,
  };
}

function workspaceGitFailure(
  result: GitProcessResult,
  operation: WorkspaceGitOperation,
  opts: Pick<WorkspaceGitOptions, "checkoutMode" | "timeoutMs" | "redactSecrets">,
): AppError {
  const rawStderr = result.stderr.toString("utf8");
  const redacted = redactGitText(
    result.stderrLimited ? completeLines(rawStderr) : rawStderr,
    opts.redactSecrets ?? [],
  );
  const failureKind = gitFailureKind(result, redacted);
  const timeoutSource = gitTimeoutSource(result, failureKind);
  const diagnostics = gitDiagnostics(result, operation, opts, timeoutSource);
  const context = {
    ...diagnostics,
    failureKind,
    ...(result.spawnErrorCode != null ? { spawnErrorCode: result.spawnErrorCode } : {}),
    ...(result.outputLimited ? { outputLimited: true } : {}),
    cleanup: result.cleanup,
    ...(result.cleanupErrorCode != null ? { cleanupErrorCode: result.cleanupErrorCode } : {}),
    stderr: stderrDiagnostic(redacted),
  };
  if (result.timedOut && operation === "fetch") {
    return new AppError({
      domain: "pr_workspace",
      kind: "fetch_timeout",
      message: `git fetch timed out after ${opts.timeoutMs} ms`,
      context,
    });
  }
  return new AppError({
    domain: "pr_workspace",
    kind: "git_failed",
    message: workspaceGitFailureMessage(operation, result, failureKind, opts.timeoutMs),
    context,
  });
}

function workspaceGitFailureMessage(
  operation: WorkspaceGitOperation,
  result: GitProcessResult,
  failureKind: WorkspaceGitFailureKind,
  timeoutMs: number,
): string {
  if (result.spawnErrorCode != null) {
    return `git ${operation} could not start (${result.spawnErrorCode})`;
  }
  if (result.timedOut) return `git ${operation} timed out after ${timeoutMs} ms`;
  if (result.outputLimited) return `git ${operation} exceeded its output limit`;
  const status =
    result.exitCode != null
      ? `exit code ${result.exitCode}`
      : `signal ${result.signal ?? "unknown"}`;
  return failureKind === "git"
    ? `git ${operation} failed with ${status}`
    : `git ${operation} failed with ${status} (${failureKind})`;
}

const WORKSPACE_GIT_INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "SYSTEMROOT",
  "GIT_EXEC_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

function workspaceGitEnv(opts: WorkspaceGitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WORKSPACE_GIT_INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    LC_ALL: "C",
    ...(opts.gitDir ? { GIT_DIR: opts.gitDir } : {}),
    ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
    ...(opts.askpass ? { GIT_ASKPASS: opts.askpass, GIT_TOKEN_FILE: opts.tokenFile ?? "" } : {}),
    ...opts.extraEnv,
  };
}

function startWorkspaceGit(
  args: readonly string[],
  opts: WorkspaceGitOptions,
): Promise<GitProcessResult> {
  return runGitProcess(["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: opts.processCwd ?? opts.cwd,
    env: workspaceGitEnv(opts),
    timeoutMs: opts.timeoutMs,
    maxBufferBytes: opts.maxBufferBytes ?? LOCAL_WORKSPACE_GIT_MAX_BUFFER_BYTES,
    stdin: opts.stdin,
  });
}

function isCleanExit(result: GitProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.outputLimited &&
    result.spawnErrorCode == null &&
    result.cleanup !== "failed"
  );
}

export async function runWorkspaceGit(
  args: readonly string[],
  opts: WorkspaceGitOptions,
): Promise<{
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
  diagnostics: WorkspaceGitDiagnostics;
}> {
  const operation = workspaceGitOperation(args);
  const result = await startWorkspaceGit(args, opts);
  if (!isCleanExit(result)) throw workspaceGitFailure(result, operation, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stdoutBuffer: result.stdout,
    stderr: result.stderr.toString("utf8"),
    diagnostics: gitDiagnostics(result, operation, opts, null),
  };
}

export function workspaceGitFailureKind(error: unknown): WorkspaceGitFailureKind | null {
  if (!isAppError(error)) return null;
  if (error.code !== "pr_workspace.fetch_timeout" && error.code !== "pr_workspace.git_failed") {
    return null;
  }
  const kind = error.context.failureKind;
  return kind === "timeout" || kind === "auth" || kind === "missing_ref" || kind === "git"
    ? kind
    : "git";
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
  const args = ["grep", "-nF", "-I", "-z", "-e", params.query, "--", ...pathspecs];
  const opts: WorkspaceGitOptions = {
    cwd: workspace.privateGitDir,
    gitDir: workspace.privateGitDir,
    timeoutMs: params.timeoutMs,
    workTree: workspace.agentCwd,
    processCwd: workspace.agentCwd,
    maxBufferBytes: params.maxOutputBytes,
  };
  const result = await startWorkspaceGit(args, opts);
  if (isCleanExit(result)) {
    const stdout = result.stdout.toString("utf8");
    return {
      matches: parseGitGrepOutput(stdout),
      truncated: false,
      stdoutBytes: result.stdout.length,
    };
  }
  if (
    result.exitCode === 1 &&
    !result.timedOut &&
    !result.outputLimited &&
    result.spawnErrorCode == null &&
    result.stderr.length === 0
  ) {
    return { matches: [], truncated: false, stdoutBytes: 0 };
  }
  if (
    result.outputLimited &&
    !result.timedOut &&
    result.cleanup !== "failed" &&
    !result.stderrLimited
  ) {
    return {
      matches: parseGitGrepOutput(result.stdout.toString("utf8")),
      truncated: true,
      stdoutBytes: result.stdout.length,
    };
  }
  throw workspaceGitFailure(result, "grep", opts);
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
    });
  }

  async function getDiffForPath(path: string): Promise<WorkspacePathDiff> {
    return classifyPinnedPrDiff({
      path,
      changedFileByPath,
      changedFiles,
      patchByPath,
      patchOmittedByCapPaths,
      truncated: stats.truncated,
    });
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
  const grepLiteral = (grepParams: GitGrepWorkspaceParams) => fffSearch.search(grepParams);

  const lookupSymbol = (name: string, maxResults = LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS) =>
    querySymbolIndex(symbolIndex, name, maxResults);
  const getSymbolIndexStatus = () => symbolIndexStatus(symbolIndex);
  const reader: PinnedRepositoryReader = {
    ...filesystemReader(agentCwd),
    agentCwd,
    headSha,
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
  readonly getDiffForPath: (path: string) => Promise<WorkspacePathDiff>;
};

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

function workspaceGitOptions(root: string): WorkspaceGitOptions {
  return { cwd: root, timeoutMs: LOCAL_WORKSPACE_FETCH_TIMEOUT_MS };
}

async function untrackedFileDiff(root: string, rel: string): Promise<string | null> {
  const status = await runWorkspaceGit(
    ["status", "--porcelain", "-z", "--untracked-files=all", "--", rel],
    workspaceGitOptions(root),
  );
  const untracked = status.stdout.split("\0").some((entry) => entry === `?? ${rel}`);
  if (!untracked) return null;
  const result = await startWorkspaceGit(
    ["diff", "--no-index", "--", "/dev/null", rel],
    workspaceGitOptions(root),
  );
  const usable =
    !result.timedOut &&
    !result.outputLimited &&
    result.spawnErrorCode == null &&
    result.cleanup !== "failed" &&
    (result.exitCode === 0 || result.exitCode === 1);
  if (!usable) throw workspaceGitFailure(result, "diff", workspaceGitOptions(root));
  return result.stdout.toString("utf8");
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
      const { stdout } = await runWorkspaceGit(
        ["diff", "HEAD", "--", rel],
        workspaceGitOptions(root),
      );
      if (stdout.length > 0) {
        return { availability: "available", reason: null, diff: stdout };
      }
      const created = await untrackedFileDiff(root, rel);
      if (created != null) {
        return { availability: "available", reason: null, diff: created };
      }
      return { availability: "unchanged", reason: "matches_head", diff: "" };
    },
  };
}

export type PathPolicy = {
  readonly allows: (path: string) => boolean;
  readonly assertDiff: (path: string) => string;
  readonly resolveRead: (path: string) => Promise<string>;
  readonly allowsSearch: (path: string) => Promise<boolean>;
};
