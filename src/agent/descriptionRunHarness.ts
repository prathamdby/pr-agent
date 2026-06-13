import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import { assistantFromText, runSubmitOnlyRound } from "../agentRun/sessionHelpers.js";
import { logInfo } from "../evlog.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "./descriptionSchema.js";
import {
  DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
  DESCRIPTION_SUBMIT_ONLY_NUDGE,
  DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
} from "../settings/index.js";
import type { DescriptionRunResult } from "./descriptionRun.js";
import {
  buildDescriptionRunSetup,
  buildSubmitOnlyDescriptionSessionTools,
  shouldContinueDescriptionRun,
} from "./descriptionRunSetup.js";

export async function runDescriptionHarness(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  cwd?: string;
  workspace: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
}): Promise<DescriptionRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.agentProvider;
  const setup = buildDescriptionRunSetup(params);
  const runner = resolveAgentRunnerProvider(cfg);
  const session = await runner.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
    refreshBeforeTool: setup.refreshBeforeTool,
  });

  let lastText = "";

  const sendSubmitOnlyRepair = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, buildSubmitOnlyDescriptionSessionTools(setup), prompt);

  const runValidationRepair = async () => {
    for (
      let repair = 0;
      repair < DESCRIPTION_VALIDATION_REPAIR_ROUNDS && shouldContinueDescriptionRun(setup);
      repair++
    ) {
      const validationError = setup.submitState.lastValidationError;
      if (!validationError) break;
      setup.submitState.lastValidationError = null;
      lastText = await sendSubmitOnlyRepair(
        [
          validationError,
          "Fix the payload and call submitDescription again with a complete DescriptionPayload.",
          `Minimal valid example:\n${JSON.stringify(DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
        ].join("\n\n"),
      );
    }
  };

  try {
    lastText = (
      await session.send(setup.userContent, {
        maxToolRounds: cfg.maxToolRoundsDescribe,
      })
    ).text;

    for (
      let nudge = 0;
      nudge < DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS && shouldContinueDescriptionRun(setup);
      nudge++
    ) {
      if (setup.submitState.published) break;
      lastText = await sendSubmitOnlyRepair(DESCRIPTION_SUBMIT_ONLY_NUDGE);
      await runValidationRepair();
    }

    await runValidationRepair();

    if (setup.submitState.published) {
      logInfo("description_run_completed", { owner, repo, pr: prNumber });
    }

    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      published: setup.submitState.published,
      publishSuperseded: setup.submitState.publishSuperseded,
    };
  } finally {
    await session.dispose();
  }
}
