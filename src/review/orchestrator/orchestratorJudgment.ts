import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import type { AgentRunnerProvider } from "../../agent/providers/index.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { ReviewPublishContext } from "../reviewSchema.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import type { ThreadPublishRunState } from "../publish/threadPublishRunState.js";
import type { SpecialistTickState } from "../run/progressComment.js";
import { renderBriefMessage, type SpecialistBrief } from "./briefTool.js";
import { pumpSpecialistCompletions } from "./completionPump.js";
import { resolveSpecialistDispatchStaggerMs, specialistTimeoutMs } from "./deadlineBudget.js";
import { ensureReportPublished } from "./ensureReportPublished.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import type { OrchestratorSendResult } from "./orchestratorSend.js";
import type { OrchestratorSessionController } from "./orchestratorSessionController.js";
import type { PublishThreadToolHandle } from "./publishThreadTool.js";
import { isDeadlineSpecialistError, type RunAbortScope } from "./runAbortScope.js";
import { SPECIALIST_IDS, type SpecialistId, type SpecialistOutcome } from "./specialistReport.js";
import { runSpecialist } from "./specialistRun.js";

export type JudgmentPhaseResult = {
  readonly lastText: string;
  readonly specialistOutcomes: Record<string, string>;
  readonly specialistTicks: SpecialistTickState;
  readonly outcomes: SpecialistOutcome[];
  readonly superseded: boolean;
  readonly allErrored: boolean;
  readonly allDeadlineErrored: boolean;
};

export type RunJudgmentPhaseParams = {
  readonly cfg: Config;
  readonly cwd?: string;
  readonly workspaceAgentCwd: string;
  readonly brief: SpecialistBrief;
  readonly workspacePiTools: readonly PiTool[];
  readonly workspaceExecutors: Record<string, AgentRunnerToolExecutor>;
  readonly provider: AgentRunnerProvider;
  readonly abort: RunAbortScope;
  readonly controller: OrchestratorSessionController;
  readonly threadTool: PublishThreadToolHandle;
  readonly token: InstallationTokenHandle;
  readonly ctx: ReviewPublishContext;
  readonly recordPublishStep: RecordPublishStepWithCoordination;
  readonly runState: ThreadPublishRunState;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly specialistDispatchStaggerMs?: number;
  /** Shared with the outer run so mid-judgment maybeTick sees live row updates. */
  readonly specialistTicks: SpecialistTickState;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sendTurn: (args: {
    readonly prompt: string;
    readonly opts?: { readonly maxToolRounds?: number };
    readonly phase: string;
    readonly shouldSend?: () => boolean;
  }) => Promise<OrchestratorSendResult>;
  readonly maybeTick: (runPhase?: "in_progress" | "superseded_rescheduled") => Promise<void>;
};

/** Dispatch specialists, pump completions, and ensure each report is published. */
export async function runJudgmentPhase(
  params: RunJudgmentPhaseParams,
): Promise<JudgmentPhaseResult> {
  let lastText = "";
  const specialistTicks = params.specialistTicks;
  const specialistOutcomes: Record<string, string> = {};
  const staggerMs = resolveSpecialistDispatchStaggerMs(params.specialistDispatchStaggerMs);

  const dispatchNowMs = params.now();
  const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>();
  for (let index = 0; index < SPECIALIST_IDS.length; index++) {
    const specialist = SPECIALIST_IDS[index]!;
    const startStaggerMs = index * staggerMs;
    const timeoutMs = specialistTimeoutMs({
      nowMs: dispatchNowMs,
      deadlineAtMs: params.abort.deadlineAtMs,
      configTimeoutMs: params.cfg.reviewSpecialistTimeoutMs,
      startStaggerMs,
    });
    pending.set(
      specialist,
      runSpecialist({
        cfg: params.cfg,
        cwd: params.cwd ?? params.workspaceAgentCwd,
        specialist,
        briefMessage: renderBriefMessage(params.brief, specialist),
        workspaceTools: {
          piTools: params.workspacePiTools,
          executors: params.workspaceExecutors,
        },
        timeoutMs,
        shouldContinue: params.abort.shouldKeepRunning,
        deadlineAtMs: params.abort.deadlineAtMs,
        signal: params.abort.signal,
        startDelayMs: startStaggerMs,
        now: params.now,
        sleep: params.sleep,
        provider: params.provider,
      }),
    );
  }

  const handleOutcome = async (outcome: SpecialistOutcome): Promise<void> => {
    specialistOutcomes[outcome.specialist] = outcome.kind;

    const outcomeGate = await params.abort.gate();
    if (outcomeGate === "superseded") return;

    switch (outcome.kind) {
      case "empty": {
        specialistTicks[outcome.specialist] = { phase: "no_findings" };
        await params.maybeTick("in_progress");
        return;
      }
      case "error": {
        specialistTicks[outcome.specialist] = { phase: "failed" };
        if (!params.runState.partialSpecialists.includes(outcome.specialist)) {
          params.runState.partialSpecialists.push(outcome.specialist);
        }
        logWarn("review_specialist_failed", {
          specialist: outcome.specialist,
          message: outcome.error.message,
        });
        await params.maybeTick("in_progress");
        return;
      }
      case "report": {
        const published = await ensureReportPublished({
          outcome,
          cfg: params.cfg,
          ctx: params.ctx,
          token: params.token,
          recordPublishStep: params.recordPublishStep,
          runState: params.runState,
          cachedDiffIndex: params.cachedDiffIndex,
          abort: params.abort,
          controller: params.controller,
          threadTool: params.threadTool,
          sendTurn: params.sendTurn,
        });
        if (published.lastText != null) lastText = published.lastText;
        specialistTicks[outcome.specialist] = published.tick;
        if (published.shouldProgressTick) {
          await params.maybeTick("in_progress");
        }
        return;
      }
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  };

  // Keep consuming after the internal deadline so reports can flush as summary-only;
  // stop only on external supersede (decision 26). Cheap cancel is owned by the run-scoped monitor.
  const outcomes = await pumpSpecialistCompletions({
    pending,
    onOutcome: handleOutcome,
    shouldContinue: () => !params.abort.isSuperseded(),
    signal: params.abort.signal,
  });

  if (!params.abort.shouldKeepRunning() || params.abort.deadlinePassed()) {
    params.abort.abortSessions();
  }

  const allErrored =
    outcomes.length === SPECIALIST_IDS.length && outcomes.every((item) => item.kind === "error");
  const allDeadlineErrored =
    allErrored &&
    outcomes.every((item) => item.kind === "error" && isDeadlineSpecialistError(item.error));

  return {
    lastText,
    specialistOutcomes,
    specialistTicks,
    outcomes,
    superseded: params.abort.isSuperseded(),
    allErrored,
    allDeadlineErrored,
  };
}
