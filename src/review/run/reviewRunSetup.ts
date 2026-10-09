import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { type Config, CONTEXT7_RESPONSE_BYTES } from "../../settings/index.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { createAskPathGate } from "../../agent/ask/askSafety.js";
import { buildContext7Tools } from "../../agent/tools/context7Tools.js";
import { hideWorkspaceToolsBehindCodeMode } from "../../agent/codemode/assembleExplorationTools.js";
import { buildWorkspaceTools } from "../../agent/tools/workspaceToolset.js";
import { createCachedPrDiffIndex, type CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { wrapUntrustedBlock, wrapUntrustedEvidence } from "../../agent/prompts/promptBlocks.js";
import { wrapExecutorsWithRateLimitCircuit } from "../../github/rateLimitCircuit.js";
import { createEvidenceLedger, type EvidenceLedger } from "../findings/evidenceLedger.js";

export type ReviewRunSetup = {
  readonly orchestratorUserContent: string;
  readonly workspaceTools: {
    readonly piTools: PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  readonly disposeSpillFiles: () => Promise<readonly string[]>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly evidenceLedger: EvidenceLedger;
  readonly prSurface: PrSurface;
};

function serializeToolOutput(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

function wrapReviewToolExecutors(
  executors: Record<string, AgentRunnerToolExecutor>,
): Record<string, AgentRunnerToolExecutor> {
  return Object.fromEntries(
    Object.entries(executors).map(([name, executor]) => [
      name,
      async (args, ctx?) =>
        wrapUntrustedEvidence("tool." + name, serializeToolOutput(await executor(args, ctx))),
    ]),
  );
}

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
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  trustedContext?: string;
  workspace: LocalPrWorkspace;
  workItemId?: string;
}): ReviewRunSetup {
  const { cfg, prSurface, owner, repo, prNumber, headSha, userSupplement, trustedContext } = params;

  const cachedDiffIndex: CachedPrDiffIndex =
    params.workspace.reader.diffIndex ?? createCachedPrDiffIndex();
  const evidenceLedger = createEvidenceLedger(headSha);
  const pathGate = createAskPathGate();
  const localTools = buildWorkspaceTools(params.workspace.reader, {
    pathGate,
    headSha,
    ...(params.workItemId != null
      ? { spillScope: { workItemId: params.workItemId, toolCall: "readWorkspaceFile" } }
      : {}),
  });
  const bundle = hideWorkspaceToolsBehindCodeMode(localTools, {
    executorKind: cfg.codeMode.executorKind,
    evidenceLedger,
    headSha,
  });
  const ctx7 = buildContext7Tools({
    apiKey: cfg.context7.apiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });
  const rateLimitedExecutors = wrapExecutorsWithRateLimitCircuit({
    ...bundle.executors,
    ...ctx7.executors,
  });
  const wrappedExecutors = wrapReviewToolExecutors(rateLimitedExecutors);
  const workspaceTools = {
    piTools: [...bundle.piTools, ...ctx7.piTools],
    executors: wrappedExecutors,
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
    disposeSpillFiles: localTools.disposeSpillFiles,
    cachedDiffIndex,
    evidenceLedger,
    prSurface,
  };
}
