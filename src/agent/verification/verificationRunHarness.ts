import type { Config } from "../../config.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
} from "../../agentRun/structuredAgentLoop.js";
import { logInfo } from "../../evlog.js";
import { resolveAgentRunnerProvider } from "../providers/index.js";
import type { VerificationRunResult } from "./verificationRun.js";
import {
  buildSubmitOnlyVerificationSessionTools,
  buildVerificationRunSetup,
  shouldContinueVerificationRun,
} from "./verificationRunSetup.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import {
  VERIFICATION_PRE_SUBMIT_NUDGE_ROUNDS,
  VERIFICATION_VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";

const VERIFICATION_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitVerification now with a complete VerificationPayload.";

export async function runVerificationHarness(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly rootDir: string;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedCommits: readonly { readonly sha: string; readonly subject: string }[];
}): Promise<VerificationRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.agentProvider;
  const setup = buildVerificationRunSetup(params);
  const runner = resolveAgentRunnerProvider(cfg);
  const session = await runner.createSession({
    cfg,
    cwd: params.rootDir,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
  });

  let lastText = "";
  const sendSubmitOnlyRepair = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, buildSubmitOnlyVerificationSessionTools(setup), prompt);

  const runValidationRepair = async () => {
    await runValidationRepairLoop({
      rounds: VERIFICATION_VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueVerificationRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      repair: async (validationError) => {
        lastText = await sendSubmitOnlyRepair(
          [validationError, "Fix the payload and call submitVerification again."].join("\n\n"),
        );
      },
    });
  };

  try {
    await runStructuredAgentLoop({
      shouldContinue: () => shouldContinueVerificationRun(setup),
      phases: [
        {
          name: "investigation",
          run: async () => {
            lastText = (
              await session.send(setup.userContent, {
                maxToolRounds: cfg.maxToolRoundsVerification,
              })
            ).text;
          },
        },
        {
          name: "pre_submit",
          run: async () => {
            for (
              let nudge = 0;
              nudge < VERIFICATION_PRE_SUBMIT_NUDGE_ROUNDS && shouldContinueVerificationRun(setup);
              nudge++
            ) {
              lastText = await sendSubmitOnlyRepair(VERIFICATION_SUBMIT_ONLY_NUDGE);
              await runValidationRepair();
            }
          },
        },
        {
          name: "validation_repair",
          run: async () => {
            await runValidationRepair();
          },
        },
      ],
    });

    if (setup.submitState.submitted) {
      logInfo("verification_run_completed", { owner, repo, pr: prNumber });
    }

    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      submitted: setup.submitState.submitted,
      payload: setup.submitState.payload,
    };
  } finally {
    await session.dispose();
  }
}
