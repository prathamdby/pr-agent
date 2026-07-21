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
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";

const TOKEN_REFRESH_TOOL = "getPullRequest";

/** Read-only workspace + Context7 tools shared by the orchestrator recon and specialists. */
export type ReviewWorkspaceToolBundle = {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  /** Required live token handle for every orchestrated-review GitHub write (decision 27). */
  readonly token: InstallationTokenHandle;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
};

/**
 * Build the shared read-only workspace + Context7 tool bundle (no publish tools).
 * Orchestrator recon and every specialist reuse this over the same checkout cwd.
 * The executor's mint callback still feeds the holder via {@link createRefreshableToolExecutors}.
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

  const ctx7 = buildContext7Tools({
    apiKey: params.cfg.context7ApiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });

  // Preserve the mutable refreshable executor store so applyFreshToken updates stay live.
  // Spreading `{ ...refreshableGh.bundle.executors }` would snapshot slots and break refresh.
  const executors = Object.assign(refreshableGh.bundle.executors, ctx7.executors);

  const token: InstallationTokenHandle = {
    getToken: refreshableGh.getToken,
    getExpiresAtTs: refreshableGh.getTokenExpiresAtTs,
    refreshNearExpiry: refreshableGh.refreshNearExpiry,
  };

  return {
    piTools: [...refreshableGh.bundle.piTools, ...ctx7.piTools],
    executors,
    cachedDiffIndex,
    token,
    refreshBeforeTool: refreshableGh.refreshBeforeTool,
  };
}
