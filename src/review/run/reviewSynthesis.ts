import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type {
  AgentRunnerProvider,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import type { Config } from "../../config.js";
import { PROSE_ONLY_NUDGE, VALIDATION_REPAIR_ROUNDS } from "../../settings/index.js";
import { buildSubmissionOnlySynthesisSystemPrompt } from "../prompts/reviewOrchestratorPrompt.js";
import { VALIDATION_REPAIR_REMINDER } from "../prompts/reviewPromptBlocks.js";
import { REVIEW_PAYLOAD_MINIMAL_EXAMPLE } from "../reviewSchema.js";
import type { SubmitReviewState } from "../publish/submitReviewTool.js";
import type { CriticId, CriticReport } from "./reviewCritics.js";
import { buildSynthesisContext } from "./reviewEnsemble.js";
import { sendReviewAgentTurn } from "./reviewRunAgentSend.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import type { ReviewSessionRegistry } from "./reviewSessionRegistry.js";
import { createReviewToolCallRecorder } from "./reviewToolCallRecorder.js";

const HYBRID_SYNTHESIS_INSTRUCTION =
  "Synthesize these validated critic reports into one ReviewPayload. Merge semantic duplicates, reject unsupported claims, never invent findings no critic raised, and call submitReview exactly once.";

export function buildHybridSynthesisContext(params: {
  readonly reports: readonly CriticReport[];
  readonly failedCriticIds: readonly CriticId[];
  readonly unvalidatedHighRisk?: number;
}): string {
  return buildSynthesisContext({
    reports: params.reports.map(({ critic, ...rest }) => ({ reviewer: critic, ...rest })),
    failed: params.failedCriticIds,
    unvalidatedHighRisk: params.unvalidatedHighRisk,
    instruction: HYBRID_SYNTHESIS_INSTRUCTION,
  });
}

/**
 * One submission-only synthesis turn (KTD8): the session holds only submitReview,
 * plus bounded schema-repair rounds when validation rejects the payload.
 */
export async function runSubmissionOnlySynthesis(params: {
  readonly cfg: Config;
  readonly runner: AgentRunnerProvider;
  readonly cwd?: string;
  readonly userContent: string;
  readonly synthesisContext: string;
  readonly submitTool: PiTool;
  readonly submitExecutor: AgentRunnerToolExecutor;
  readonly submitState: SubmitReviewState;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly registry: ReviewSessionRegistry;
}): Promise<string> {
  const { cfg, submitState } = params;
  let lastText = "";
  let sentMinimalExample = false;
  const shouldContinue = () =>
    !submitState.published && !submitState.publishSuperseded && !params.signal?.aborted;
  const minimalExampleOnce = (): string | null => {
    if (sentMinimalExample) return null;
    sentMinimalExample = true;
    return `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`;
  };

  const session = await params.runner.createSession({
    cfg,
    cwd: params.cwd,
    signal: params.signal,
    systemPrompt: buildSubmissionOnlySynthesisSystemPrompt(),
    tools: [params.submitTool],
    executors: { submitReview: params.submitExecutor },
    refreshBeforeTool: params.refreshBeforeTool,
    onToolCallMetric: createReviewToolCallRecorder("orchestrator"),
  });
  const unregister = params.registry.register(session);
  try {
    const sendOpts = { maxToolRounds: cfg.maxToolRoundsOrchestrator, signal: params.signal };
    lastText = (
      await sendReviewAgentTurn(
        session,
        [params.userContent, params.synthesisContext].join("\n\n"),
        sendOpts,
      )
    ).text;

    const runRepair = () =>
      runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue,
        getValidationError: () => submitState.lastValidationError,
        clearValidationError: () => {
          submitState.lastValidationError = null;
        },
        repair: async (validationError) => {
          recordReviewMetric({ kind: "phase_enter", phase: "validation_repair" });
          lastText = (
            await sendReviewAgentTurn(
              session,
              [validationError, minimalExampleOnce() ?? VALIDATION_REPAIR_REMINDER].join("\n\n"),
              sendOpts,
            )
          ).text;
        },
      });

    await runRepair();
    if (shouldContinue() && !submitState.lastValidationError) {
      recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
      lastText = (
        await sendReviewAgentTurn(
          session,
          [PROSE_ONLY_NUDGE, minimalExampleOnce()].filter(Boolean).join("\n\n"),
          sendOpts,
        )
      ).text;
      await runRepair();
    }
    return lastText;
  } finally {
    unregister();
    await session.dispose();
  }
}
