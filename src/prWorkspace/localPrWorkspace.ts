import {
  readRepositorySource,
  createPinnedRepositoryReader,
  runWorkspaceGit,
  workspaceGitFailureKind,
  type ChangedFileStatus,
  type LocalPrChangedFile,
  type LocalPrWorkspaceCheckoutMode,
  type PinnedRepositoryReader,
} from "./repositoryReader.ts";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ListPullRequestFilesResult,
  PullRequestFileEntry,
} from "../github/listPullRequestFiles.ts";
import { createCachedPrDiffIndex, ingestListPullRequestFilesResult } from "./reviewDiffIndex.ts";
import {
  LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY,
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES,
  LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS,
  READ_SPILL_FILENAME_PREFIX,
} from "../settings/index.ts";
import { AppError, isAppError } from "../errors/appError.ts";
import { logWarn } from "../evlog.ts";
import { readBasePolicySnapshot, type PolicySnapshot } from "./policySnapshot.ts";
import {
  failedFetchAttempt,
  succeededFetchAttempt,
  type WorkspaceCheckoutMode,
  type WorkspaceCheckoutTelemetry,
  type WorkspaceFallbackReason,
  type WorkspaceFetchAttempt,
} from "./checkoutTelemetry.ts";
import { enforceObjectStoreByteCap } from "./objectStoreBytes.ts";
import {
  allocateWorkspaceResource,
  READONLY_WORKSPACE_ROOT_PREFIX,
  sweepStaleOwnedWorkspaces,
  assertGitSha,
  assertGitRepoPart,
  ensureWorkspaceFreeSpaceAfterSweep,
  statIfPresent,
  type WorkspaceResource,
} from "./workspaceResource.ts";
import { buildSymbolIndex, isIndexableSourcePath, type SymbolIndex } from "./symbolIndex.ts";

const PRIVATE_CHECKOUT_DIR = "private";
const AGENT_TREE_DIR = "agent";
const PR_HEAD_REF = "pr-head";

type CheckoutRecorder = {
  readonly plannedMode: LocalPrWorkspaceCheckoutMode;
  mode: WorkspaceCheckoutMode;
  fallbackReason: WorkspaceFallbackReason | null;
  readonly fetchAttempts: WorkspaceFetchAttempt[];
};

const checkoutTelemetryByError = new WeakMap<object, WorkspaceCheckoutTelemetry>();

function checkoutTelemetrySnapshot(recorder: CheckoutRecorder) {
  return ((pinnedReturn: WorkspaceCheckoutTelemetry) => pinnedReturn)({
    mode: recorder.mode,
    fallbackReason: recorder.fallbackReason,
    fetchAttempts: [...recorder.fetchAttempts],
  });
}

export function workspaceCheckoutTelemetryFromError(error: unknown) {
  return ((pinnedReturn: WorkspaceCheckoutTelemetry | undefined) => pinnedReturn)(
    typeof error === "object" && error !== null ? checkoutTelemetryByError.get(error) : undefined,
  );
}

function sparseFallbackReason(error: unknown) {
  if (!isAppError(error))
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)(null);
  if (error.context.spawnErrorCode != null || error.context.cleanup === "failed")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)(null);
  if (error.code === "pr_workspace.fetch_too_large")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)("fetch_too_large");
  if (error.context.operation !== "fetch")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)(null);
  if (error.code === "pr_workspace.fetch_timeout")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)("fetch_timeout");
  if (error.code !== "pr_workspace.git_failed")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)(null);
  const failureKind = workspaceGitFailureKind(error);
  if (failureKind === "git")
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)("git_failed");
  if (failureKind === "timeout" && error.context.timeoutSource === "git_low_speed") {
    return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)("git_low_speed");
  }
  return ((pinnedReturn: WorkspaceFallbackReason | null) => pinnedReturn)(null);
}

function fetchAttemptContext(attempt: WorkspaceFetchAttempt) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    checkoutMode: attempt.checkoutMode,
    errorCode: attempt.errorCode,
    failureKind: attempt.failureKind,
    timeoutSource: attempt.timeoutSource,
    exitCode: attempt.exitCode,
    signal: attempt.signal,
    killed: attempt.killed,
    elapsedMs: attempt.elapsedMs,
    stderr: attempt.stderr,
  });
}

function withFallbackContext(error: unknown, fullAttempt: WorkspaceFetchAttempt) {
  if (!isAppError(error)) return ((pinnedReturn: unknown) => pinnedReturn)(error);
  const kind =
    error.code === "pr_workspace.fetch_timeout"
      ? "fetch_timeout"
      : error.code === "pr_workspace.git_failed"
        ? "git_failed"
        : error.code === "pr_workspace.fetch_too_large"
          ? "fetch_too_large"
          : null;
  if (kind == null) return ((pinnedReturn: unknown) => pinnedReturn)(error);
  return ((pinnedReturn: unknown) => pinnedReturn)(
    new AppError({
      domain: "pr_workspace",
      kind,
      message: error.message,
      context: { ...error.context, fallback: fetchAttemptContext(fullAttempt) },
    }),
  );
}

function replaceSuccessfulFetchAttempt(
  recorder: CheckoutRecorder,
  mode: LocalPrWorkspaceCheckoutMode,
  error: unknown,
) {
  if (!isAppError(error) || error.code !== "pr_workspace.fetch_too_large") return;
  const index = recorder.fetchAttempts.findLastIndex(
    (attempt) => attempt.checkoutMode === mode && attempt.outcome === "succeeded",
  );
  if (index >= 0) recorder.fetchAttempts[index] = failedFetchAttempt(mode, error);
}

export type LocalPrWorkspace = {
  readonly rootDir: string;
  readonly privateGitDir: string;
  readonly agentCwd: string;
  readonly reader: PinnedRepositoryReader;
  readonly policySnapshot: PolicySnapshot;
  readonly checkoutTelemetry: WorkspaceCheckoutTelemetry;
  readonly cleanup: () => Promise<void>;
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
  readonly maxFetchBytes?: number;
  readonly fetchTimeoutMs?: number;
  readonly baseSha?: string;
};

export async function stripWorkspaceSymlinks(dir: string) {
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

function mapGithubStatus(file: PullRequestFileEntry) {
  const status = file.status;
  if (status === "renamed" || status === "copied") {
    return ((pinnedReturn: LocalPrChangedFile) => pinnedReturn)({
      path: file.filename,
      status,
      ...(file.previousFilename ? { oldPath: file.previousFilename } : {}),
    });
  }
  const mapped: ChangedFileStatus =
    status === "added"
      ? "added"
      : status === "removed"
        ? "deleted"
        : status === "modified" || status === "changed"
          ? "modified"
          : "other";
  return ((pinnedReturn: LocalPrChangedFile) => pinnedReturn)({
    path: file.filename,
    status: mapped,
  });
}

export function selectLocalPrWorkspaceCheckoutMode(repositorySizeKb?: number) {
  return ((pinnedReturn: LocalPrWorkspaceCheckoutMode) => pinnedReturn)(
    repositorySizeKb != null && repositorySizeKb > LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB
      ? "sparse"
      : "full",
  );
}

async function prepareCheckedOutTree(dir: string, prefix = "") {
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
  return ((pinnedReturn: Set<string> | Promise<Set<string>>) => pinnedReturn)(paths);
}

function sparseCheckoutPattern(path: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `/${path.replace(/\\/g, "/").replace(/[\\*?[]/g, "\\$&")}`,
  );
}

function sparseCheckoutPatterns(changedFiles: readonly LocalPrChangedFile[]) {
  const paths = changedFiles
    .filter((file) => file.status !== "deleted")
    .map((file) => sparseCheckoutPattern(file.path));
  return ((pinnedReturn: string) => pinnedReturn)(paths.length > 0 ? `${paths.join("\n")}\n` : "");
}

const PI_AGENT_DIR_PREFIX = "pr-agent-pi-";

async function cleanupStaleTemporaryEntries(kind: "session" | "spill", staleAgeSeconds: number) {
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    const matches =
      kind === "session"
        ? entry.isDirectory() && entry.name.startsWith(PI_AGENT_DIR_PREFIX)
        : entry.isFile() && entry.name.startsWith(READ_SPILL_FILENAME_PREFIX);
    if (!matches) continue;

    const full = join(tmpdir(), entry.name);
    const entryStat = await statIfPresent(full);
    if (!entryStat || (kind === "spill" && !entryStat.isFile())) continue;
    const stale = now - entryStat.mtimeMs > staleAgeSeconds * 1000;
    if (!stale) continue;

    const removal = kind === "session" ? rm(full, { recursive: true, force: true }) : rm(full);
    await removal.catch(() => undefined);
  }
}

export async function cleanupStaleLocalPrWorkspaces(
  options: { readonly staleAgeSeconds?: number } = {},
) {
  const staleAgeSeconds = options.staleAgeSeconds ?? LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS;
  await cleanupStaleTemporaryEntries("session", staleAgeSeconds);
  await cleanupStaleTemporaryEntries("spill", staleAgeSeconds);
  await sweepStaleOwnedWorkspaces({ staleAgeSeconds });
}

export async function prepareLocalPrWorkspace(params: PrepareLocalPrWorkspaceParams) {
  const { owner, repo, headSha, installationToken } = params;
  assertGitRepoPart(owner, "owner");
  assertGitRepoPart(repo, "repo");
  assertGitSha(headSha, "headSha");
  await ensureWorkspaceFreeSpaceAfterSweep(
    tmpdir(),
    LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
    "Insufficient free space for local PR workspace",
    () => cleanupStaleLocalPrWorkspaces(),
  );

  const resource = await allocateWorkspaceResource({
    prefix: READONLY_WORKSPACE_ROOT_PREFIX,
    installationToken,
  });
  const plannedMode = selectLocalPrWorkspaceCheckoutMode(params.repositorySizeKb);
  const recorder: CheckoutRecorder = {
    plannedMode,
    mode: plannedMode,
    fallbackReason: null,
    fetchAttempts: [],
  };
  try {
    return ((pinnedReturn: LocalPrWorkspace | Promise<LocalPrWorkspace>) => pinnedReturn)(
      await finishLocalPrWorkspace(params, resource, recorder),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      checkoutTelemetryByError.set(error, checkoutTelemetrySnapshot(recorder));
    }
    await resource.release();
    throw error;
  }
}

async function finishLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
  resource: WorkspaceResource,
  recorder: CheckoutRecorder,
) {
  const { owner, repo, prNumber, headSha, prFiles } = params;
  const rootDir = resource.rootDir;
  const credentials = resource.credentials;
  const privateGitDir = join(rootDir, PRIVATE_CHECKOUT_DIR);
  const agentCwd = join(rootDir, AGENT_TREE_DIR);
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const changedFiles = prFiles.files.map(mapGithubStatus);
  const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  let checkoutMode = recorder.plannedMode;
  const fetchTimeoutMs = params.fetchTimeoutMs ?? LOCAL_WORKSPACE_FETCH_TIMEOUT_MS;
  const maxFetchBytes = params.maxFetchBytes ?? LOCAL_WORKSPACE_MAX_FETCH_BYTES;
  const diffIndex = createCachedPrDiffIndex();
  const patchByPath = new Map<string, string>();
  const patchOmittedByCapPaths = new Set<string>();
  const filesForIndex = [];
  for (const file of prFiles.files) {
    if (file.patchOmitted) {
      patchOmittedByCapPaths.add(file.filename);
    } else if (file.patch != null) {
      patchByPath.set(file.filename, file.patch);
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

  const git = (
    args: readonly string[],
    timeoutMs = LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    io?: { readonly stdin?: Buffer | string; readonly extraEnv?: Record<string, string> },
  ) =>
    runWorkspaceGit(args, {
      gitDir: privateGitDir,
      cwd: privateGitDir,
      timeoutMs,
      tokenFile: credentials.tokenFile,
      askpass: credentials.askpass,
      workTree: agentCwd,
      checkoutMode,
      objectStoreByteLimit: {
        objectsDir: join(privateGitDir, "objects"),
        maxBytes: maxFetchBytes,
      },
      redactSecrets: [params.installationToken],
      stdin: io?.stdin,
      extraEnv: io?.extraEnv,
    });

  let checkoutPaths = new Set<string>();
  let sortedCheckoutPaths: string[] = [];
  const isPathInCheckout = (path: string) => checkoutPaths.has(path.replace(/\\/g, "/"));
  const initPrivateRepository = async () => {
    await mkdir(privateGitDir, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await git(["init"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
    await git(["remote", "add", "origin", remoteUrl], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
  };
  const prRef = `+refs/pull/${prNumber}/head:refs/heads/${PR_HEAD_REF}`;
  const fetchPrHead = async (mode: LocalPrWorkspaceCheckoutMode) => {
    const fetchArgs = [
      "-c",
      `http.lowSpeedLimit=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES}`,
      "-c",
      `http.lowSpeedTime=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS}`,
      "fetch",
      "--no-tags",
      "--depth=1",
      ...(mode === "sparse" ? ["--filter=blob:none"] : []),
      "--no-recurse-submodules",
      "origin",
      prRef,
    ];
    try {
      const { diagnostics } = await git(fetchArgs, fetchTimeoutMs);
      recorder.fetchAttempts.push(succeededFetchAttempt(mode, diagnostics));
    } catch (error) {
      recorder.fetchAttempts.push(failedFetchAttempt(mode, error));
      throw error;
    }
  };
  const materializePrHead = async (mode: LocalPrWorkspaceCheckoutMode) => {
    try {
      await fetchPrHead(mode);
      if (mode === "sparse") {
        await git(["config", "core.sparseCheckout", "true"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
        await git(["config", "core.sparseCheckoutCone", "false"], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
        await writeFile(
          join(privateGitDir, "info", "sparse-checkout"),
          sparseCheckoutPatterns(changedFiles),
        );
      }
      await git(["checkout", "-f", PR_HEAD_REF], LOCAL_WORKSPACE_CLONE_TIMEOUT_MS);
      await enforceObjectStoreByteCap(join(privateGitDir, "objects"), maxFetchBytes);
    } catch (error) {
      replaceSuccessfulFetchAttempt(recorder, mode, error);
      throw error;
    }
  };

  await initPrivateRepository();
  try {
    await materializePrHead(checkoutMode);
  } catch (error) {
    const fallbackReason = checkoutMode === "full" ? sparseFallbackReason(error) : null;
    const fullAttempt = recorder.fetchAttempts[0];
    if (fallbackReason == null || fullAttempt == null) throw error;
    logWarn("local_pr_workspace_sparse_fallback", {
      owner,
      repo,
      pr: prNumber,
      headSha,
      fallbackReason,
      ...fetchAttemptContext(fullAttempt),
    });
    recorder.mode = "sparse_fallback";
    recorder.fallbackReason = fallbackReason;
    checkoutMode = "sparse";
    await rm(agentCwd, { recursive: true, force: true });
    await rm(privateGitDir, { recursive: true, force: true });
    await initPrivateRepository();
    try {
      await materializePrHead(checkoutMode);
    } catch (sparseError) {
      throw withFallbackContext(sparseError, fullAttempt);
    }
  }
  const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
  if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "head_sha_mismatch",
      message: `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
      context: { fetchedHead: fetchedHead.trim(), headSha },
    });
  }

  const policySnapshot = await readBasePolicySnapshot({
    baseSha: params.baseSha,
    git,
    timeoutMs: fetchTimeoutMs,
  });
  await enforceObjectStoreByteCap(join(privateGitDir, "objects"), maxFetchBytes);

  await credentials.cleanup();
  checkoutPaths = await prepareCheckedOutTree(agentCwd);
  sortedCheckoutPaths = [...checkoutPaths].toSorted();

  let symbolIndex: SymbolIndex | null = null;

  async function readIndexableFile(path: string) {
    const normalized = path.replace(/\\/g, "/");
    if (!isPathInCheckout(normalized) || !isIndexableSourcePath(normalized))
      return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(null);
    return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(
      readRepositorySource(agentCwd, normalized, LOCAL_WORKSPACE_MAX_FILE_BYTES),
    );
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

  const readerResource = createPinnedRepositoryReader({
    agentCwd,
    privateGitDir,
    headSha,
    checkoutPaths,
    sortedCheckoutPaths,
    checkoutMode,
    changedFiles,
    changedFileByPath,
    diffIndex,
    patchByPath,
    patchOmittedByCapPaths,
    objectStoreByteLimit: {
      objectsDir: join(privateGitDir, "objects"),
      maxBytes: maxFetchBytes,
    },
    symbolIndex,
    stats: {
      truncated: prFiles.truncated,
      totalChanges: prFiles.totalChanges,
      fileCount: changedFiles.length,
      warning: prFiles.warning,
    },
  });
  return ((pinnedReturn: LocalPrWorkspace | Promise<LocalPrWorkspace>) => pinnedReturn)({
    rootDir,
    privateGitDir,
    agentCwd,
    reader: readerResource.reader,
    policySnapshot,
    checkoutTelemetry: checkoutTelemetrySnapshot(recorder),
    cleanup: async () => {
      readerResource.dispose();
      await resource.release();
    },
  });
}
