import type { Config } from "../config.js";
import { assistantFromText, runSubmitOnlyRound } from "../agentRun/sessionHelpers.js";
import { logInfo } from "../evlog.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import type { TriageRunResult } from "./triageRun.js";
import {
  buildSubmitOnlyTriageSessionTools,
  buildTriageRunSetup,
  shouldContinueTriageRun,
} from "./triageRunSetup.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import type { WritablePrCheckout } from "../prWorkspace/writablePrCheckout.js";
import {
  TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS,
  TRIAGE_VALIDATION_REPAIR_ROUNDS,
} from "../settings/index.js";

const TRIAGE_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitTriage now with a complete TriagePayload.";

export async function runTriageHarness(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly cwd?: string;
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
    runSubmitOnlyRound(session, buildSubmitOnlyTriageSessionTools(setup), prompt);

  const runValidationRepair = async () => {
    for (
      let repair = 0;
      repair < TRIAGE_VALIDATION_REPAIR_ROUNDS && shouldContinueTriageRun(setup);
      repair++
    ) {
      const validationError = setup.submitState.lastValidationError;
      if (!validationError) break;
      setup.submitState.lastValidationError = null;
      lastText = await sendSubmitOnlyRepair(
        [validationError, "Fix the payload and call submitTriage again."].join("\n\n"),
      );
    }
  };

  try {
    lastText = (
      await session.send(setup.userContent, {
        maxToolRounds: cfg.maxToolRoundsTriage,
      })
    ).text;

    for (
      let nudge = 0;
      nudge < TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS && shouldContinueTriageRun(setup);
      nudge++
    ) {
      lastText = await sendSubmitOnlyRepair(TRIAGE_SUBMIT_ONLY_NUDGE);
      await runValidationRepair();
    }

    await runValidationRepair();

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
