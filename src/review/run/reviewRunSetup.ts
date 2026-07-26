import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import { createAskPathGate } from "../../agent/ask/askSafety.js";
import { buildContext7Tools } from "../../agent/tools/context7Tools.js";
import { buildLocalWorkspaceTools } from "../../agent/tools/localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "../../agent/tools/refreshableGithubTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "../placement/reviewDiffIndex.js";
import { CONTEXT7_RESPONSE_BYTES } from "../../settings/index.js";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import { wrapExecutorsWithRateLimitCircuit } from "../../github/rateLimitCircuit.js";
import { createEvidenceLedger, type EvidenceLedger } from "../findings/evidenceLedger.js";
import type { Pool } from "pg";
import {
  buildCodeIndexTools,
  buildUnavailableCodeIndexTools,
} from "../../agent/tools/codeIndexTools.js";

export type ReviewRunSetup = {
  readonly orchestratorUserContent: string;
  readonly workspaceTools: {
    readonly piTools: PiTool[];
    readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  };
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly evidenceLedger: EvidenceLedger;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
  readonly refreshLiveAuth: () => Promise<void>;
};

const TOKEN_REFRESH_TOOL = "getPullRequest";

function buildOrchestratorUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly userSupplement?: string;
  readonly trustedContext?: string;
}): string {
  return [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
    params.userSupplement
      ? `\n${wrapUntrustedBlock("user_supplement", params.userSupplement)}\n`
      : "",
    params.trustedContext ? `\n${params.trustedContext}\n` : "",
  ].join("\n");
}

export function buildReviewRunSetup(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  trustedContext?: string;
  workspace: LocalPrWorkspace;
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
  pool?: Pool;
  codeIndexSnapshotId?: string;
}): ReviewRunSetup {
  const {
    cfg,
    token,
    tokenExpiresAtTs,
    owner,
    repo,
    prNumber,
    headSha,
    userSupplement,
    trustedContext,
  } = params;

  const cachedDiffIndex: CachedPrDiffIndex =
    params.workspace.diffIndex ?? createCachedPrDiffIndex();
  const evidenceLedger = createEvidenceLedger(headSha);
  const pathGate = createAskPathGate();
  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    tokenTtlMs: params.tokenTtlMs,
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (_activeToken, _activeExpiresAtTs) => {
      const bundle = buildLocalWorkspaceTools(params.workspace, {
        pathGate,
        evidenceLedger,
        headSha,
      });
      const executors = { ...bundle.executors };
      wrapListPullRequestFilesDiffIngestion(executors, cachedDiffIndex);
      return { piTools: bundle.piTools, executors };
    },
  });

  const ctx7 = buildContext7Tools({
    apiKey: cfg.context7ApiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });
  const codeIndex =
    params.pool && params.codeIndexSnapshotId
      ? buildCodeIndexTools({
          pool: params.pool,
          snapshotId: params.codeIndexSnapshotId,
          workspace: params.workspace,
          pathGate,
        })
      : buildUnavailableCodeIndexTools();
  const executors = wrapExecutorsWithRateLimitCircuit({
    ...refreshableGh.bundle.executors,
    ...ctx7.executors,
    ...codeIndex.executors,
  });
  const workspaceTools = {
    piTools: [...refreshableGh.bundle.piTools, ...ctx7.piTools, ...codeIndex.piTools],
    executors,
  };
  const refreshBeforeTool = async (toolName: string) => {
    if (refreshableGh.githubExecutorNames.has(toolName)) {
      await refreshableGh.refreshBeforeTool(TOKEN_REFRESH_TOOL);
    }
  };

  return {
    orchestratorUserContent: buildOrchestratorUserContent({
      owner,
      repo,
      prNumber,
      headSha,
      userSupplement,
      trustedContext,
    }),
    workspaceTools,
    cachedDiffIndex,
    evidenceLedger,
    getToken: refreshableGh.getToken,
    getTokenExpiresAtTs: refreshableGh.getTokenExpiresAtTs,
    refreshBeforeTool,
    refreshLiveAuth: () => refreshableGh.refreshBeforeTool(TOKEN_REFRESH_TOOL),
  };
}
