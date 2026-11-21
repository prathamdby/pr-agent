import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import type { Config } from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import {
  buildWorkspaceTools,
  hideWorkspaceToolsBehindCodeMode,
  type ReviewThreadSource,
  type WorkspaceToolBundle,
} from "../../agent/runtime/durable/piTools.ts";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
} from "../../prWorkspace/reviewDiffIndex.ts";
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
    readonly durableTools: WorkspaceToolBundle["durableTools"];
    readonly toolMeta: WorkspaceToolBundle["toolMeta"];
  };
  readonly createSpecialistWorkspaceTools: (
    specialist: SpecialistId,
    reviewThreads: ReviewThreadSource,
  ) => {
    readonly piTools: PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
    readonly durableTools: WorkspaceToolBundle["durableTools"];
    readonly toolMeta: WorkspaceToolBundle["toolMeta"];
  };
  readonly disposeSpillFiles: () => Promise<readonly string[]>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly evidenceLedger: EvidenceLedger;
  readonly specialistLedgers: Readonly<Record<SpecialistId, EvidenceLedger>>;
  readonly prSurface: PrSurface;
  readonly bindReviewThreads: (source: ReviewThreadSource) => void;
};

function serializeToolOutput(result: unknown) {
  if (typeof result === "string") return ((pinnedReturn: string) => pinnedReturn)(result);
  try {
    return ((pinnedReturn: string) => pinnedReturn)(
      JSON.stringify(result, null, 2) ?? String(result),
    );
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(String(result));
  }
}

function wrapReviewToolExecutors(executors: Record<string, AgentRunnerToolExecutor>) {
  return ((pinnedReturn: Record<string, AgentRunnerToolExecutor>) => pinnedReturn)(
    Object.fromEntries(
      Object.entries(executors).map(([name, executor]) => [
        name,
        async (args, ctx?) =>
          wrapUntrustedEvidence("tool." + name, serializeToolOutput(await executor(args, ctx))),
      ]),
    ),
  );
}

function codeModeWorkspaceView(localTools: WorkspaceToolBundle) {
  const bundle = hideWorkspaceToolsBehindCodeMode(localTools);
  return {
    piTools: [...bundle.piTools],
    executors: wrapReviewToolExecutors(wrapExecutorsWithRateLimitCircuit(bundle.executors)),
    durableTools: bundle.durableTools,
    toolMeta: bundle.toolMeta,
  };
}

function buildOrchestratorUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly userSupplement?: string;
  readonly trustedContext?: string;
}) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      `Target repository: ${params.owner}/${params.repo}`,
      `Pull request #: ${params.prNumber}`,
      `Head commit SHA: ${params.headSha}`,
      params.userSupplement
        ? `\n${wrapUntrustedBlock("user_supplement", params.userSupplement)}\n`
        : "",
      params.trustedContext ? `\n${params.trustedContext}\n` : "",
    ].join("\n"),
  );
}

export function ledgerForFindingSource(
  source: FindingSource,
  ledgers: {
    readonly orchestrator: EvidenceLedger;
    readonly specialists: Readonly<Record<SpecialistId, EvidenceLedger>>;
  },
) {
  if (source === "review")
    return ((pinnedReturn: EvidenceLedger) => pinnedReturn)(ledgers.orchestrator);
  return ((pinnedReturn: EvidenceLedger) => pinnedReturn)(ledgers.specialists[source]);
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
}) {
  const { prSurface, owner, repo, prNumber, headSha, userSupplement, trustedContext } = params;

  const cachedDiffIndex: CachedPrDiffIndex =
    params.workspace.reader.diffIndex ?? createCachedPrDiffIndex();
  const evidenceLedger = createEvidenceLedger(headSha);
  const specialistLedgers = Object.fromEntries(
    SPECIALIST_IDS.map((specialist) => [specialist, createEvidenceLedger(headSha)]),
  ) as Record<SpecialistId, EvidenceLedger>;
  const reviewThreadSource: { current: ReviewThreadSource } = { current: () => [] };
  const specialistDisposals: Array<() => Promise<readonly string[]>> = [];
  const investigationOptions = (
    toolCall: string,
    reviewThreads: ReviewThreadSource,
    ledger: EvidenceLedger,
  ) => ({
    headSha,
    evidenceLedger: ledger,
    reviewThreads,
    ...(params.workItemId != null
      ? { spillScope: { workItemId: params.workItemId, toolCall } }
      : {}),
  });
  const localTools = buildWorkspaceTools(
    params.workspace.reader,
    investigationOptions("read_pinned", () => reviewThreadSource.current(), evidenceLedger),
  );
  const workspaceTools = codeModeWorkspaceView(localTools);

  return ((pinnedReturn: ReviewRunSetup) => pinnedReturn)({
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
        investigationOptions(`read_pinned:${specialist}`, reviewThreads, specialistLedger),
      );
      specialistDisposals.push(tools.disposeSpillFiles);
      return codeModeWorkspaceView(tools);
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
  });
}
