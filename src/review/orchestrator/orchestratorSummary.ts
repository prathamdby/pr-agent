import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import {
  MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";
import type { Config } from "../../config.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import type { ReviewPublishContext } from "../reviewSchema.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { ThreadPublishRunState } from "../publish/threadPublishRunState.js";
import type { SpecialistBrief } from "./briefTool.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import type { OrchestratorSendResult } from "./orchestratorSend.js";
import type { OrchestratorSessionController } from "./orchestratorSessionController.js";
import { renderSynthesisTurn } from "./prompts/orchestratorPrompts.js";
import type { CapturedSummaryOverview } from "./publishSummaryTool.js";
import type { RunAbortScope } from "./runAbortScope.js";
import type { SpecialistOutcome } from "./specialistReport.js";
import { finalizeReviewSummary } from "./summaryFinalizer.js";

export type SummaryToolHandle = {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
  readonly getLastError: () => string | null;
  readonly clearLastError: () => void;
  readonly getCapturedOverview: () => CapturedSummaryOverview | null;
  readonly hasCaptured: () => boolean;
};

export type SummaryPhaseResult = {
  readonly lastText: string;
  readonly published: boolean;
  readonly superseded: boolean;
  readonly judgmentDegraded: boolean;
};

export type RunSummaryPhaseParams = {
  readonly cfg: Config;
  readonly ctx: ReviewPublishContext;
  readonly token: InstallationTokenHandle;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly abort: RunAbortScope;
  readonly controller: OrchestratorSessionController;
  readonly summaryTool: SummaryToolHandle;
  readonly brief: SpecialistBrief;
  readonly outcomes: readonly SpecialistOutcome[];
  readonly forceDeterministic: boolean;
  readonly deadlineReached: boolean;
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly restoreThenRestrict: (
    tools: readonly PiTool[],
    executors: Record<string, AgentRunnerToolExecutor>,
  ) => void;
  readonly sendTurn: (args: {
    readonly prompt: string;
    readonly opts?: { readonly maxToolRounds?: number };
    readonly phase: string;
    readonly shouldSend?: () => boolean;
  }) => Promise<OrchestratorSendResult>;
};

/**
 * Synthesis (optional) + single terminal summary finalize.
 * Exactly one production {@link publishReviewSummaryOnly} call via {@link finalizeReviewSummary}.
 */
export async function runSummaryPhase(params: RunSummaryPhaseParams): Promise<SummaryPhaseResult> {
  let lastText = "";
  let logSynthesisDegraded = false;

  if (!params.forceDeterministic) {
    params.restoreThenRestrict([params.summaryTool.piTool], {
      [params.summaryTool.piTool.name]: params.summaryTool.executor,
    });

    const emptySpecialists = params.outcomes
      .filter(
        (item): item is Extract<SpecialistOutcome, { kind: "empty" }> => item.kind === "empty",
      )
      .map((item) => item.specialist);

    const synthesisPrompt = renderSynthesisTurn({
      acceptedFindings: params.runState.acceptedFindings,
      partialSpecialists: params.runState.partialSpecialists,
      emptySpecialists,
      brief: params.brief,
    });

    const synthesisSend = await params.sendTurn({
      prompt: synthesisPrompt,
      opts: { maxToolRounds: MAX_TOOL_ROUNDS },
      phase: "synthesis",
      shouldSend: () => params.abort.shouldKeepRunning() && !params.summaryTool.hasCaptured(),
    });

    if (synthesisSend.ok) {
      lastText = synthesisSend.turn.text;
      if (
        !params.summaryTool.hasCaptured() &&
        params.summaryTool.getLastError() != null &&
        params.abort.shouldKeepRunning()
      ) {
        await runValidationRepairLoop({
          rounds: VALIDATION_REPAIR_ROUNDS,
          shouldContinue: () =>
            params.abort.shouldKeepRunning() && !params.summaryTool.hasCaptured(),
          getValidationError: () => params.summaryTool.getLastError(),
          clearValidationError: () => params.summaryTool.clearLastError(),
          repair: async (validationError) => {
            const repairSend = await params.sendTurn({
              prompt: validationError,
              opts: { maxToolRounds: MAX_TOOL_ROUNDS },
              phase: "validation_repair",
              shouldSend: () =>
                params.abort.shouldKeepRunning() && !params.summaryTool.hasCaptured(),
            });
            if (repairSend.ok) lastText = repairSend.turn.text;
            else params.controller.markDegraded();
          },
        });
      }
      if (!params.summaryTool.hasCaptured()) {
        for (
          let round = 0;
          round < PUBLISH_RECOVERY_ROUNDS &&
          params.abort.shouldKeepRunning() &&
          !params.summaryTool.hasCaptured();
          round++
        ) {
          const recovery = await params.sendTurn({
            prompt:
              "Call publish_summary exactly once now with overview fields for the accepted findings.",
            opts: { maxToolRounds: MAX_TOOL_ROUNDS },
            phase: "synthesis_recovery",
            shouldSend: () => params.abort.shouldKeepRunning() && !params.summaryTool.hasCaptured(),
          });
          if (recovery.ok) lastText = recovery.turn.text;
          else break;
        }
      }
    }

    if (!params.summaryTool.hasCaptured() && !params.abort.isSuperseded()) {
      params.controller.markDegraded();
      logSynthesisDegraded = true;
    }
  }

  if (params.abort.isSuperseded()) {
    return {
      lastText,
      published: false,
      superseded: true,
      judgmentDegraded: params.controller.isDegraded(),
    };
  }

  const forceDeterministic = params.forceDeterministic || !params.summaryTool.hasCaptured();

  const finalized = await finalizeReviewSummary({
    cfg: params.cfg,
    ctx: params.ctx,
    token: params.token,
    recordPublishStep: params.recordPublishStep,
    runState: params.runState,
    cachedDiffIndex: params.cachedDiffIndex,
    abort: params.abort,
    capturedOverview: params.summaryTool.getCapturedOverview(),
    forceDeterministic,
    judgmentDegraded: params.controller.isDegraded(),
    deadlineReached: params.deadlineReached,
    logSynthesisDegraded,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
  });

  return {
    lastText,
    published: finalized.published,
    superseded: params.abort.isSuperseded(),
    judgmentDegraded: params.controller.isDegraded(),
  };
}
