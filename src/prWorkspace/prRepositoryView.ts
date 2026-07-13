import type { Config } from "../config.js";
import {
  buildReviewPreflightMetadataFromWorkspace,
  type ReviewPreflightMetadata,
} from "../review/placement/reviewPreflightFiles.js";
import {
  assertPullRequestFilesHeadSha,
  fetchPullRequestFiles,
  type ListPullRequestFilesResult,
  type PullRequestForFileList,
} from "../github/listPullRequestFiles.js";
import { logWarn } from "../evlog.js";
import { PR_REPOSITORY_VIEW_RELEASE_GRACE_MS } from "../settings/index.js";
import {
  prepareLocalPrWorkspace,
  selectLocalPrWorkspaceCheckoutMode,
  type LocalPrWorkspace,
} from "./localPrWorkspace.js";

export type PrRepositoryView = {
  readonly workspace: LocalPrWorkspace;
  readonly preflight: ReviewPreflightMetadata;
  readonly agentCwd: string;
};

export type PreparePrRepositoryViewParams = {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationToken: string;
  readonly installationExpiresAtTs?: number;
  readonly prFiles?: ListPullRequestFilesResult;
  readonly pullRequest?: PullRequestForFileList;
  readonly repositorySizeKb?: number;
  /** Derive the authoritative three-dot change set from git (KTD2). */
  readonly deriveAuthoritativeChangeSet?: boolean;
};

type CachedPrRepositoryView = PrRepositoryView & {
  readonly cleanup: () => Promise<void>;
};

type CacheEntry = {
  refcount: number;
  view: CachedPrRepositoryView | null;
  prepare: Promise<CachedPrRepositoryView> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

const cache = new Map<string, CacheEntry>();

function cancelReleaseTimer(entry: CacheEntry): void {
  if (!entry.releaseTimer) return;
  clearTimeout(entry.releaseTimer);
  entry.releaseTimer = null;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

function cacheKey(
  params: Pick<
    PreparePrRepositoryViewParams,
    | "cfg"
    | "owner"
    | "repo"
    | "prNumber"
    | "headSha"
    | "repositorySizeKb"
    | "deriveAuthoritativeChangeSet"
  >,
): string {
  const checkoutMode = selectLocalPrWorkspaceCheckoutMode(params.cfg, params.repositorySizeKb);
  const derived = params.deriveAuthoritativeChangeSet ? ":derived" : "";
  return `${params.owner}/${params.repo}#${params.prNumber}:${params.headSha}:${checkoutMode}${derived}`;
}

async function prepareUncached(
  params: PreparePrRepositoryViewParams,
): Promise<CachedPrRepositoryView> {
  const prFiles =
    params.prFiles ??
    (await fetchPullRequestFiles(
      params.installationToken,
      params.owner,
      params.repo,
      params.prNumber,
      {
        maxPrFilesListed: params.cfg.maxPrFilesListed,
        maxPrFilesPatchBytes: params.cfg.maxPrFilesPatchBytes,
      },
      params.pullRequest,
      params.installationExpiresAtTs,
    ));
  assertPullRequestFilesHeadSha(prFiles, params.headSha);
  const workspace = await prepareLocalPrWorkspace({
    cfg: params.cfg,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: params.headSha,
    installationToken: params.installationToken,
    prFiles,
    repositorySizeKb: params.repositorySizeKb,
    deriveAuthoritativeChangeSet: params.deriveAuthoritativeChangeSet,
  });
  return {
    workspace,
    preflight: buildReviewPreflightMetadataFromWorkspace(workspace),
    agentCwd: workspace.agentCwd,
    cleanup: () => workspace.cleanup(),
  };
}

async function prepareEntry(
  entry: CacheEntry,
  params: PreparePrRepositoryViewParams,
): Promise<CachedPrRepositoryView> {
  if (entry.view) return entry.view;
  if (!entry.prepare) {
    entry.prepare = prepareUncached(params)
      .then((view) => {
        entry.view = view;
        return view;
      })
      .catch((e) => {
        entry.prepare = null;
        throw e;
      });
  }
  return entry.prepare;
}

async function acquirePrRepositoryView(
  params: PreparePrRepositoryViewParams,
): Promise<PrRepositoryView> {
  const key = cacheKey(params);
  let entry = cache.get(key);
  if (!entry) {
    entry = { refcount: 0, view: null, prepare: null, releaseTimer: null };
    cache.set(key, entry);
  }
  cancelReleaseTimer(entry);
  entry.refcount += 1;
  try {
    return await prepareEntry(entry, params);
  } catch (e) {
    await releasePrRepositoryView(params);
    throw e;
  }
}

async function releasePrRepositoryView(
  params: Pick<
    PreparePrRepositoryViewParams,
    | "cfg"
    | "owner"
    | "repo"
    | "prNumber"
    | "headSha"
    | "repositorySizeKb"
    | "deriveAuthoritativeChangeSet"
  >,
): Promise<void> {
  const key = cacheKey(params);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount > 0) return;
  const view = entry.view;
  if (!view) {
    cache.delete(key);
    entry.prepare = null;
    return;
  }
  const timer = setTimeout(() => {
    if (entry.refcount > 0) return;
    cache.delete(key);
    entry.view = null;
    entry.prepare = null;
    void view.cleanup().catch((error: unknown) => {
      logWarn("pr_repository_view_cleanup_failed", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        headSha: params.headSha,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, PR_REPOSITORY_VIEW_RELEASE_GRACE_MS);
  entry.releaseTimer = timer;
  unrefTimer(timer);
}

export async function withPrRepositoryView<T>(
  params: PreparePrRepositoryViewParams,
  fn: (view: PrRepositoryView) => Promise<T>,
): Promise<T> {
  const view = await acquirePrRepositoryView(params);
  try {
    return await fn(view);
  } finally {
    await releasePrRepositoryView(params);
  }
}
