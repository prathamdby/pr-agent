import type { Config } from "../config.js";
import {
  buildReviewPreflightMetadataFromWorkspace,
  type ReviewPreflightMetadata,
} from "../review/reviewPreflightFiles.js";
import { fetchPullRequestFiles } from "../github/listPullRequestFiles.js";
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
  readonly repositorySizeKb?: number;
};

type CachedPrRepositoryView = PrRepositoryView & {
  readonly cleanup: () => Promise<void>;
};

type CacheEntry = {
  refcount: number;
  view: CachedPrRepositoryView | null;
  prepare: Promise<CachedPrRepositoryView> | null;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(
  params: Pick<
    PreparePrRepositoryViewParams,
    "cfg" | "owner" | "repo" | "prNumber" | "headSha" | "repositorySizeKb"
  >,
): string {
  const checkoutMode = selectLocalPrWorkspaceCheckoutMode(params.cfg, params.repositorySizeKb);
  return `${params.owner}/${params.repo}#${params.prNumber}:${params.headSha}:${checkoutMode}`;
}

async function prepareUncached(
  params: PreparePrRepositoryViewParams,
): Promise<CachedPrRepositoryView> {
  const prFiles = await fetchPullRequestFiles(
    params.installationToken,
    params.owner,
    params.repo,
    params.prNumber,
    {
      maxPrFilesListed: params.cfg.maxPrFilesListed,
      maxPrFilesPatchBytes: params.cfg.maxPrFilesPatchBytes,
    },
  );
  if (prFiles.headSha?.toLowerCase() !== params.headSha.toLowerCase()) {
    throw new Error(
      `Pull request head SHA ${prFiles.headSha ?? "unknown"} does not match work item headSha ${params.headSha}`,
    );
  }
  const workspace = await prepareLocalPrWorkspace({
    cfg: params.cfg,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: params.headSha,
    installationToken: params.installationToken,
    prFiles,
    repositorySizeKb: params.repositorySizeKb,
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
    entry = { refcount: 0, view: null, prepare: null };
    cache.set(key, entry);
  }
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
    "cfg" | "owner" | "repo" | "prNumber" | "headSha" | "repositorySizeKb"
  >,
): Promise<void> {
  const key = cacheKey(params);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount > 0) return;
  cache.delete(key);
  const view = entry.view;
  entry.view = null;
  entry.prepare = null;
  if (view) await view.cleanup();
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
