import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import type { Config } from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import { createAskPathGate } from "../../agent/ask/askSafety.ts";
import { hideWorkspaceToolsBehindCodeMode } from "../../agent/codemode/assembleExplorationTools.ts";
import {
  buildWorkspaceTools,
  type ReviewThreadSource,
} from "../../agent/tools/workspaceToolset.ts";
import { createCachedPrDiffIndex, type CachedPrDiffIndex } from "../placement/reviewDiffIndex.ts";
import { wrapUntrustedBlock, wrapUntrustedEvidence } from "../../prompts/shared/safety.ts";
import { wrapExecutorsWithRateLimitCircuit } from "../../github/rateLimitCircuit.ts";
import { createEvidenceLedger, type EvidenceLedger } from "../findings/evidenceLedger.ts";

export type ReviewRunSetup = {
  readonly orchestratorUserContent: string;
  readonly trustedContext: string;
  readonly workspaceTools: {
    readonly piTools: PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  readonly disposeSpillFiles: () => Promise<readonly string[]>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly evidenceLedger: EvidenceLedger;
  readonly prSurface: PrSurface;
  readonly bindReviewThreads: (source: ReviewThreadSource) => void;
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
  const reviewThreadSource: { current: ReviewThreadSource } = { current: () => [] };
  const localTools = buildWorkspaceTools(params.workspace.reader, {
    pathGate,
    headSha,
    reviewThreads: () => reviewThreadSource.current(),
    ...(params.workItemId != null
      ? { spillScope: { workItemId: params.workItemId, toolCall: "readWorkspaceFile" } }
      : {}),
  });
  const bundle = hideWorkspaceToolsBehindCodeMode(localTools, {
    executorKind: cfg.codeMode.executorKind,
    evidenceLedger,
    headSha,
  });
  const rateLimitedExecutors = wrapExecutorsWithRateLimitCircuit(bundle.executors);
  const wrappedExecutors = wrapReviewToolExecutors(rateLimitedExecutors);
  const workspaceTools = {
    piTools: [...bundle.piTools],
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
    trustedContext: trustedContext ?? "",
    workspaceTools,
    disposeSpillFiles: localTools.disposeSpillFiles,
    cachedDiffIndex,
    evidenceLedger,
    prSurface,
    bindReviewThreads(source) {
      reviewThreadSource.current = source;
    },
  };
}
