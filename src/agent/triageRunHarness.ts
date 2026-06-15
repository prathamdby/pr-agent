import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TriageScope } from "../agentWork/types.js";
import type { Config } from "../config.js";
import { assistantFromText, runSubmitOnlyRound } from "./sessionHelpers.js";
import { logInfo } from "../evlog.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import {
  pickSubmitOnlyBundle,
  runSubmitOnlyNudgeLoop,
  runValidationRepairLoop,
} from "./runHarnessLoops.js";
import { buildTriageRunSetup, shouldContinueTriageRun } from "./triageRunSetup.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import type { TriagePayload } from "../review/triageSchema.js";
import type { WritablePrCheckout } from "../prWorkspace/writablePrCheckout.js";
import { TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS, TRIAGE_VALIDATION_REPAIR_ROUNDS } from "../settings.js";

const TRIAGE_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitTriage now with a complete TriagePayload.";

export type TriageRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly submitted: boolean;
  readonly payload: TriagePayload | null;
  readonly commitByThreadRootCommentId: ReadonlyMap<number, string>;
};

export async function runTriageHarness(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly cwd?: string;
  readonly scope?: TriageScope;
}): Promise<TriageRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.agentProvider;
  const setup = buildTriageRunSetup(params);
  const runner = resolveAgentRunnerProvider(cfg);
  const session = await runner.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
  });

  let lastText = "";
  const sendSubmitOnlyRepair = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, pickSubmitOnlyBundle(setup, "submitTriage"), prompt);

  const runValidationRepair = () =>
    runValidationRepairLoop({
      maxRounds: TRIAGE_VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueTriageRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      sendRepair: sendSubmitOnlyRepair,
      buildRepairPrompt: (validationError) =>
        [validationError, "Fix the payload and call submitTriage again."].join("\n\n"),
    });

  try {
    lastText = (
      await session.send(setup.userContent, {
        maxToolRounds: cfg.maxToolRoundsTriage,
      })
    ).text;

    const nudged = await runSubmitOnlyNudgeLoop({
      maxRounds: TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS,
      shouldContinue: () => shouldContinueTriageRun(setup),
      nudgeText: TRIAGE_SUBMIT_ONLY_NUDGE,
      sendNudge: sendSubmitOnlyRepair,
      runValidationRepair,
    });
    if (nudged) lastText = nudged;

    const repaired = await runValidationRepair();
    if (repaired) lastText = repaired;

    if (setup.submitState.submitted) {
      logInfo("triage_run_completed", { owner, repo, pr: prNumber });
    }

    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      submitted: setup.submitState.submitted,
      payload: setup.submitState.payload,
      commitByThreadRootCommentId: setup.workspaceState.commitByThreadRootCommentId,
    };
  } finally {
    await session.dispose();
  }
}
