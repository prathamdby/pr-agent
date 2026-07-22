import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { logWarn } from "../../evlog.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { MAX_TOOL_ROUNDS, VALIDATION_REPAIR_ROUNDS } from "../../settings/index.js";
import type {
  AgentRunnerSession,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { buildDeterministicBrief, renderChangedFilesSummary } from "./briefFallback.js";
import { buildSpecialistBriefTool, type SpecialistBrief } from "./briefTool.js";
import { isOrchestratorSendDegradation, type OrchestratorSendResult } from "./orchestratorSend.js";
import type { OrchestratorSessionController } from "./orchestratorSessionController.js";
import { renderReconInstruction } from "./prompts/orchestratorPrompts.js";
import type { RunAbortScope } from "./runAbortScope.js";

export type ReconPhaseResult = {
  readonly brief: SpecialistBrief;
  readonly briefFallback: boolean;
  readonly lastText: string;
  readonly superseded: boolean;
};

export type RunReconPhaseParams = {
  readonly session: AgentRunnerSession;
  readonly abort: RunAbortScope;
  readonly controller: OrchestratorSessionController;
  readonly briefTool: ReturnType<typeof buildSpecialistBriefTool>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly prTitle: string;
  readonly prBody: string;
  readonly trustedContext?: string;
  readonly userSupplement?: string;
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

/** Recon + brief capture (or deterministic brief fallback). */
export async function runReconPhase(params: RunReconPhaseParams): Promise<ReconPhaseResult> {
  let lastText = "";
  let briefFallback = false;

  const reconPrompt = [
    renderReconInstruction({
      prTitle: params.prTitle,
      prBody: params.prBody,
      changedFilesSummary: renderChangedFilesSummary(params.cachedDiffIndex),
    }),
    params.trustedContext ? `\n${params.trustedContext}\n` : "",
    params.userSupplement ? `\n${params.userSupplement}\n` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  const reconSend = await params.sendTurn({
    prompt: reconPrompt,
    opts: { maxToolRounds: MAX_TOOL_ROUNDS },
    phase: "recon",
  });
  if (reconSend.ok) {
    lastText = reconSend.turn.text;
  } else if (isOrchestratorSendDegradation(reconSend)) {
    params.controller.markDegraded();
    logWarn("review_recon_degraded", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      message: reconSend.error.message,
      reason: reconSend.reason,
    });
  }

  if (
    params.controller.canSendOrchestrator() &&
    params.briefTool.getBrief() == null &&
    params.abort.shouldKeepRunning()
  ) {
    await runValidationRepairLoop({
      rounds: VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () =>
        params.controller.canSendOrchestrator() &&
        params.abort.shouldKeepRunning() &&
        params.briefTool.getBrief() == null,
      getValidationError: () =>
        params.briefTool.getLastError() ??
        (params.briefTool.getBrief() == null
          ? "Call submit_specialist_brief exactly once with a complete specialist brief."
          : null),
      clearValidationError: () => params.briefTool.clearLastError(),
      repair: async (validationError) => {
        params.restoreThenRestrict([params.briefTool.piTool], {
          [params.briefTool.piTool.name]: params.briefTool.executor,
        });
        try {
          const repairSend = await params.sendTurn({
            prompt: validationError,
            phase: "recon_repair",
          });
          if (repairSend.ok) lastText = repairSend.turn.text;
          else if (isOrchestratorSendDegradation(repairSend)) {
            params.controller.markDegraded();
          }
        } finally {
          params.session.restoreTools();
        }
      },
    });
  }

  const brief: SpecialistBrief =
    params.briefTool.getBrief() ??
    (() => {
      briefFallback = true;
      logWarn("review_brief_fallback", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return buildDeterministicBrief({
        prTitle: params.prTitle,
        prBody: params.prBody,
        cachedDiffIndex: params.cachedDiffIndex,
      });
    })();

  const postReconGate = await params.abort.gate();
  return {
    brief,
    briefFallback,
    lastText,
    superseded: postReconGate === "superseded",
  };
}
