import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS } from "../../settings/index.js";
import type { ReviewPublishContext } from "../reviewSchema.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { ThreadPublishRunState } from "../publish/threadPublishRunState.js";
import type { SpecialistTickState } from "../run/progressComment.js";
import { accumulateUnjudgedReportAsSummaryOnly, publishUnjudgedReport } from "./degradedPublish.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import { isOrchestratorSendDegradation, type OrchestratorSendResult } from "./orchestratorSend.js";
import type { OrchestratorSessionController } from "./orchestratorSessionController.js";
import { renderJudgmentTurn } from "./prompts/orchestratorPrompts.js";
import type { PublishThreadToolHandle } from "./publishThreadTool.js";
import type { RunAbortScope } from "./runAbortScope.js";
import type { SpecialistOutcome } from "./specialistReport.js";

const PUBLISH_THREAD_SUBMIT_NUDGE =
  "Call publish_thread exactly once now with the worthy findings, or an empty findings array if nothing should publish.";

export type EnsureReportPublishedParams = {
  readonly outcome: Extract<SpecialistOutcome, { kind: "report" }>;
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly token: InstallationTokenHandle;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly abort: RunAbortScope;
  readonly controller: OrchestratorSessionController;
  readonly threadTool: PublishThreadToolHandle;
  readonly sendTurn: (args: {
    readonly prompt: string;
    readonly opts?: { readonly maxToolRounds?: number };
    readonly phase: string;
    readonly shouldSend?: () => boolean;
  }) => Promise<OrchestratorSendResult>;
};

export type EnsureReportPublishedResult = {
  readonly lastText?: string;
  readonly tick: SpecialistTickState[keyof SpecialistTickState];
  /** When true, caller should upsert the progress comment (judgment path success semantics). */
  readonly shouldProgressTick: boolean;
};

async function publishReportFallback(params: EnsureReportPublishedParams): Promise<void> {
  if (params.abort.isSuperseded()) return;
  if (params.abort.deadlinePassed()) {
    accumulateUnjudgedReportAsSummaryOnly({
      outcome: params.outcome,
      runState: params.runState,
      cachedDiffIndex: params.cachedDiffIndex,
    });
    return;
  }
  await publishUnjudgedReport({
    outcome: params.outcome,
    cfg: params.cfg,
    ctx: params.ctx,
    token: params.token,
    recordPublishStep: params.recordPublishStep,
    runState: params.runState,
    cachedDiffIndex: params.cachedDiffIndex,
    abortGate: params.abort.publishGate,
  });
}

/**
 * One report terminal helper: judgment send, validation repair, missing-call nudge,
 * and deterministic / summary-only fallback. Returns the specialist tick update.
 */
export async function ensureReportPublished(
  params: EnsureReportPublishedParams,
): Promise<EnsureReportPublishedResult> {
  const { outcome, abort, controller, threadTool, runState } = params;
  let lastText: string | undefined;

  const gate = await abort.gate();
  if (gate === "superseded") {
    return {
      tick: { phase: "done", threadsPublished: 0 },
      shouldProgressTick: false,
    };
  }

  const canJudge = controller.canSendOrchestrator() && abort.shouldKeepRunning();

  if (!canJudge) {
    await publishReportFallback(params);
    return {
      tick: { phase: "done", threadsPublished: 0 },
      shouldProgressTick: false,
    };
  }

  const beforePosted = runState.postedInlineCount;
  threadTool.beginTurn();

  const judgmentSend = await params.sendTurn({
    prompt: renderJudgmentTurn(outcome, {
      previouslyAcceptedFindings: runState.acceptedFindings,
    }),
    opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
    phase: "judgment",
  });

  if (!judgmentSend.ok) {
    if (isOrchestratorSendDegradation(judgmentSend)) {
      controller.markDegraded();
      logWarn("review_judgment_degraded", {
        specialist: outcome.specialist,
        message: judgmentSend.error.message,
      });
    }
    await publishReportFallback(params);
    return {
      tick: { phase: "done", threadsPublished: 0 },
      shouldProgressTick: false,
    };
  }
  lastText = judgmentSend.turn.text;

  const afterJudgmentGate = await abort.gate();
  if (afterJudgmentGate === "superseded") {
    return {
      lastText,
      tick: { phase: "done", threadsPublished: 0 },
      shouldProgressTick: false,
    };
  }

  let gatedSend = false;

  if (threadTool.getLastError() != null && abort.shouldKeepRunning()) {
    await runValidationRepairLoop({
      rounds: 1,
      shouldContinue: () => abort.shouldKeepRunning(),
      getValidationError: () => threadTool.getLastError(),
      clearValidationError: () => threadTool.clearLastError(),
      repair: async (validationError) => {
        const repairSend = await params.sendTurn({
          prompt: validationError,
          opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
          phase: "judgment_repair",
        });
        if (repairSend.ok) lastText = repairSend.turn.text;
        else if (isOrchestratorSendDegradation(repairSend)) controller.markDegraded();
        else gatedSend = true;
      },
    });
  }

  if (!threadTool.hadSuccessfulCallThisTurn()) {
    if (controller.canSendOrchestrator() && abort.shouldKeepRunning()) {
      const repairSend = await params.sendTurn({
        prompt: PUBLISH_THREAD_SUBMIT_NUDGE,
        opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
        phase: "judgment_submit_repair",
      });
      if (repairSend.ok) lastText = repairSend.turn.text;
      else if (isOrchestratorSendDegradation(repairSend)) {
        controller.markDegraded();
        logWarn("review_judgment_submit_repair_failed", {
          specialist: outcome.specialist,
          message: repairSend.error.message,
        });
      } else {
        gatedSend = true;
      }
    }
  }

  if (!threadTool.hadSuccessfulCallThisTurn()) {
    // Successful send(s) without the required tool call are judgment degradation,
    // unless a later send stopped on a terminal gate (deadline / skipped / superseded).
    if (!gatedSend && abort.shouldKeepRunning()) {
      controller.markDegraded();
    }
    logWarn("review_judgment_missing_publish_thread", {
      specialist: outcome.specialist,
    });
    await publishReportFallback(params);
    return {
      lastText,
      tick: { phase: "done", threadsPublished: 0 },
      shouldProgressTick: false,
    };
  }

  const threadsPublished = Math.max(0, runState.postedInlineCount - beforePosted);
  const shouldProgressTick = !controller.isDegraded() || threadTool.hadSuccessfulCallThisTurn();
  return {
    lastText,
    tick: { phase: "done", threadsPublished },
    shouldProgressTick,
  };
}
