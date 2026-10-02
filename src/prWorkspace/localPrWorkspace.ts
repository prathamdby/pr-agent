import {
  readRepositorySource,
  createPinnedRepositoryReader,
  runWorkspaceGit,
  type ChangedFileStatus,
  type LocalPrChangedFile,
  type LocalPrWorkspaceCheckoutMode,
  type PinnedRepositoryReader,
} from "./repositoryReader.js";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ListPullRequestFilesResult,
  PullRequestFileEntry,
} from "../github/listPullRequestFiles.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../review/placement/reviewDiffIndex.js";
import {
  LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY,
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS,
} from "../settings/index.js";
import { AppError } from "../errors/appError.js";
import {
  allocateWorkspaceResource,
  READONLY_WORKSPACE_ROOT_PREFIX,
  sweepStaleOwnedWorkspaces,
  assertGitSha,
  assertGitRepoPart,
  ensureWorkspaceFreeSpaceAfterSweep,
  gitCountObjectsStoreBytes,
  statIfPresent,
  type WorkspaceResource,
} from "./workspaceResource.js";
import { buildSymbolIndex, isIndexableSourcePath, type SymbolIndex } from "./symbolIndex.js";

const PRIVATE_CHECKOUT_DIR = "private";
const AGENT_TREE_DIR = "agent";
const PR_HEAD_REF = "pr-head";

export type LocalPrWorkspace = {
  readonly rootDir: string;
  readonly privateGitDir: string;
  readonly agentCwd: string;
  readonly reader: PinnedRepositoryReader;
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
};

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

async function enforceMaxFetchBytes(
  git: (args: readonly string[], timeoutMs?: number) => Promise<{ stdout: string }>,
  maxFetchBytes: number,
  timeoutMs: number,
): Promise<void> {
  const { stdout: countObjectsOut } = await git(["count-objects", "-v"], timeoutMs);
  const objectStoreBytes = gitCountObjectsStoreBytes(countObjectsOut);
  if (objectStoreBytes > maxFetchBytes) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "fetch_too_large",
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

async function cleanupStalePiAgentDirs(staleAgeSeconds: number): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PI_AGENT_DIR_PREFIX)) continue;
    const full = join(tmpdir(), entry.name);
    const entryStat = await statIfPresent(full);
    if (!entryStat) continue;
    const ageMs = now - entryStat.mtimeMs;
    if (ageMs > staleAgeSeconds * 1000) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function cleanupStaleLocalPrWorkspaces(
  options: { readonly staleAgeSeconds?: number } = {},
): Promise<void> {
  const staleAgeSeconds = options.staleAgeSeconds ?? LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS;
  await cleanupStalePiAgentDirs(staleAgeSeconds);
  await sweepStaleOwnedWorkspaces({ staleAgeSeconds });
}

export async function prepareLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
): Promise<LocalPrWorkspace> {
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
    runWorkspaceGit(args, {
      gitDir: privateGitDir,
      cwd: privateGitDir,
      timeoutMs,
      tokenFile: credentials.tokenFile,
      askpass: credentials.askpass,
      workTree: agentCwd,
    });

  let checkoutPaths = new Set<string>();
  let sortedCheckoutPaths: string[] = [];
  const isPathInCheckout = (path: string) => checkoutPaths.has(path.replace(/\\/g, "/"));
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
    params.maxFetchBytes ?? LOCAL_WORKSPACE_MAX_FETCH_BYTES,
    LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  );
  const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
  if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "head_sha_mismatch",
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
    return readRepositorySource(agentCwd, normalized, LOCAL_WORKSPACE_MAX_FILE_BYTES);
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
    symbolIndex,
    stats: {
      truncated: prFiles.truncated,
      totalChanges: prFiles.totalChanges,
      fileCount: changedFiles.length,
      warning: prFiles.warning,
    },
  });
  return {
    rootDir,
    privateGitDir,
    agentCwd,
    reader: readerResource.reader,
    cleanup: async () => {
      readerResource.dispose();
      await resource.release();
    },
  };
}
