import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import type { Config } from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import { hideWorkspaceToolsBehindCodeMode } from "../../agent/codemode/assembleExplorationTools.ts";
import {
  buildWorkspaceTools,
  type ReviewThreadSource,
} from "../../agent/tools/workspaceToolset.ts";
import { createCachedPrDiffIndex, type CachedPrDiffIndex } from "../placement/reviewDiffIndex.ts";
import { wrapUntrustedBlock, wrapUntrustedEvidence } from "../../prompts/shared/safety.ts";
import { wrapExecutorsWithRateLimitCircuit } from "../../github/rateLimitCircuit.ts";
import { createEvidenceLedger, type EvidenceLedger } from "../findings/evidenceLedger.ts";
import {
  SPECIALIST_IDS,
  type FindingSource,
  type SpecialistId,
} from "../orchestrator/orchestratorTypes.ts";

export type ReviewRunSetup = {
  readonly orchestratorUserContent: string;
  readonly trustedContext: string;
  readonly workspaceTools: {
    readonly piTools: PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  readonly createSpecialistWorkspaceTools: (
    specialist: SpecialistId,
    reviewThreads: ReviewThreadSource,
  ) => {
    readonly piTools: PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  readonly disposeSpillFiles: () => Promise<readonly string[]>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly evidenceLedger: EvidenceLedger;
  readonly specialistLedgers: Readonly<Record<SpecialistId, EvidenceLedger>>;
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

function codeModeWorkspaceView(
  localTools: {
    readonly piTools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  },
  options: {
    readonly executorKind: Config["codeMode"]["executorKind"];
    readonly evidenceLedger: EvidenceLedger;
    readonly headSha: string;
  },
) {
  const bundle = hideWorkspaceToolsBehindCodeMode(localTools, {
    executorKind: options.executorKind,
    evidenceLedger: options.evidenceLedger,
    headSha: options.headSha,
  });
  return {
    piTools: [...bundle.piTools],
    executors: wrapReviewToolExecutors(wrapExecutorsWithRateLimitCircuit(bundle.executors)),
  };
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

export function ledgerForFindingSource(
  source: FindingSource,
  ledgers: {
    readonly orchestrator: EvidenceLedger;
    readonly specialists: Readonly<Record<SpecialistId, EvidenceLedger>>;
  },
): EvidenceLedger {
  if (source === "review") return ledgers.orchestrator;
  return ledgers.specialists[source];
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
  const specialistLedgers = Object.fromEntries(
    SPECIALIST_IDS.map((specialist) => [specialist, createEvidenceLedger(headSha)]),
  ) as Record<SpecialistId, EvidenceLedger>;
  const reviewThreadSource: { current: ReviewThreadSource } = { current: () => [] };
  const specialistDisposals: Array<() => Promise<readonly string[]>> = [];
  const investigationOptions = (toolCall: string, reviewThreads: ReviewThreadSource) => ({
    headSha,
    reviewThreads,
    ...(params.workItemId != null
      ? { spillScope: { workItemId: params.workItemId, toolCall } }
      : {}),
  });
  const localTools = buildWorkspaceTools(
    params.workspace.reader,
    investigationOptions("readWorkspaceFile", () => reviewThreadSource.current()),
  );
  const workspaceTools = codeModeWorkspaceView(localTools, {
    executorKind: cfg.codeMode.executorKind,
    evidenceLedger,
    headSha,
  });

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
    createSpecialistWorkspaceTools(specialist, reviewThreads) {
      const specialistLedger = specialistLedgers[specialist];
      const tools = buildWorkspaceTools(
        params.workspace.reader,
        investigationOptions(`readWorkspaceFile:${specialist}`, reviewThreads),
      );
      specialistDisposals.push(tools.disposeSpillFiles);
      return codeModeWorkspaceView(tools, {
        executorKind: cfg.codeMode.executorKind,
        evidenceLedger: specialistLedger,
        headSha,
      });
    },
    disposeSpillFiles: async () => {
      const own = await localTools.disposeSpillFiles();
      const extra = await Promise.all(specialistDisposals.splice(0).map((dispose) => dispose()));
      return [...own, ...extra.flat()];
    },
    cachedDiffIndex,
    evidenceLedger,
    specialistLedgers,
    prSurface,
    bindReviewThreads(source) {
      reviewThreadSource.current = source;
    },
  };
}
