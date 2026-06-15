import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import { assistantFromText, runSubmitOnlyRound } from "./sessionHelpers.js";
import { logInfo } from "../evlog.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "./descriptionSchema.js";
import {
  pickSubmitOnlyBundle,
  runSubmitOnlyNudgeLoop,
  runValidationRepairLoop,
} from "./runHarnessLoops.js";
import {
  DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
  DESCRIPTION_SUBMIT_ONLY_NUDGE,
  DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
} from "../settings.js";
import { buildDescriptionRunSetup, shouldContinueDescriptionRun } from "./descriptionRunSetup.js";

export type DescriptionRunResult = {
  lastAssistant: AssistantMessage;
  published: boolean;
  publishSuperseded: boolean;
};

export async function runDescriptionHarness(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
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
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

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
    runSubmitOnlyRound(session, pickSubmitOnlyBundle(setup, "submitDescription"), prompt);

  const runValidationRepair = () =>
    runValidationRepairLoop({
      maxRounds: DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueDescriptionRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      sendRepair: sendSubmitOnlyRepair,
      buildRepairPrompt: (validationError) =>
        [
          validationError,
          "Fix the payload and call submitDescription again with a complete DescriptionPayload.",
          `Minimal valid example:\n${JSON.stringify(DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
        ].join("\n\n"),
    });

  try {
    lastText = (
      await session.send(setup.userContent, {
        maxToolRounds: cfg.maxToolRoundsDescribe,
      })
    ).text;

    const nudged = await runSubmitOnlyNudgeLoop({
      maxRounds: DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
      shouldContinue: () => shouldContinueDescriptionRun(setup),
      shouldBreakEarly: () => setup.submitState.published,
      nudgeText: DESCRIPTION_SUBMIT_ONLY_NUDGE,
      sendNudge: sendSubmitOnlyRepair,
      runValidationRepair,
    });
    if (nudged) lastText = nudged;

    const repaired = await runValidationRepair();
    if (repaired) lastText = repaired;

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
