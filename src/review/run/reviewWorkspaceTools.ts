import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import { createAskPathGate } from "../../agent/ask/askSafety.js";
import { buildContext7Tools } from "../../agent/tools/context7Tools.js";
import { createRefreshableToolExecutors } from "../../agent/tools/refreshableGithubTools.js";
import { buildLocalWorkspaceTools } from "../../agent/tools/localWorkspaceTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "../placement/reviewDiffIndex.js";
import { CONTEXT7_RESPONSE_BYTES } from "../../settings/index.js";

const TOKEN_REFRESH_TOOL = "getPullRequest";

/** Read-only workspace + Context7 tools shared by the orchestrator recon and specialists. */
export type ReviewWorkspaceToolBundle = {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
  /**
   * Holder-updating near-expiry refresh (decision 27). Pass this to publish/tick/summary paths
   * so `getToken()` reflects the mint result.
   */
  readonly refreshNearExpiry: () => Promise<void>;
  /**
   * Raw refresher that updates the refreshable holder. Prefer {@link refreshNearExpiry} for
   * proactive near-expiry checks; use this when a caller already decided to mint.
   */
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
};

/**
 * Build the shared read-only workspace + Context7 tool bundle (no publish tools).
 * Orchestrator recon and every specialist reuse this over the same checkout cwd.
 */
export function buildReviewWorkspaceTools(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  workspace: LocalPrWorkspace;
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
}): ReviewWorkspaceToolBundle {
  const cachedDiffIndex: CachedPrDiffIndex =
    params.workspace.diffIndex ?? createCachedPrDiffIndex();
  const pathGate = createAskPathGate();
  const refreshableGh = createRefreshableToolExecutors({
    initialToken: params.token,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
    tokenTtlMs: params.tokenTtlMs,
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (_activeToken, _activeExpiresAtTs) => {
      const bundle = buildLocalWorkspaceTools(params.workspace, {
        pathGate,
      });
      const executors = { ...bundle.executors };
      wrapListPullRequestFilesDiffIngestion(executors, cachedDiffIndex);
      return { piTools: bundle.piTools, executors };
    },
  });

  const rawRefresh = params.refreshInstallationToken;
  const holderUpdatingRefresh =
    rawRefresh == null
      ? undefined
      : async (): Promise<{ token: string; expiresAtTs: number }> => {
          const fresh = await rawRefresh();
          refreshableGh.applyFreshToken(fresh);
          return fresh;
        };

  const ctx7 = buildContext7Tools({
    apiKey: params.cfg.context7ApiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });

  // Preserve the mutable refreshable executor store so applyFreshToken updates stay live.
  // Spreading `{ ...refreshableGh.bundle.executors }` would snapshot slots and break refresh.
  const executors = Object.assign(refreshableGh.bundle.executors, ctx7.executors);

  return {
    piTools: [...refreshableGh.bundle.piTools, ...ctx7.piTools],
    executors,
    cachedDiffIndex,
    getToken: refreshableGh.getToken,
    getTokenExpiresAtTs: refreshableGh.getTokenExpiresAtTs,
    refreshBeforeTool: refreshableGh.refreshBeforeTool,
    refreshNearExpiry: refreshableGh.refreshNearExpiry,
    refreshInstallationToken: holderUpdatingRefresh,
  };
}
