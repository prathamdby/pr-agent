import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Config,
  SUBMIT_ONLY_MAX_TOOL_ROUNDS,
  DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
  DESCRIPTION_SUBMIT_ONLY_NUDGE,
  DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
  MAX_TOOL_ROUNDS_DESCRIBE,
} from "../../settings/index.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { logInfo } from "../../evlog.js";
import { assistantFromText, runFeatureAgent } from "../runtime/featureAgent.js";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.js";
import { DESCRIPTION_PAYLOAD_BASE_EXAMPLE } from "./descriptionSchema.js";
import { buildDescriptionRunSetup, shouldContinueDescriptionRun } from "./descriptionRunSetup.js";
import type { OperationIntentContext } from "../../agentWork/publishOnce.js";
import type { FeatureSessionContext } from "../runtime/createFeatureSession.js";

export type DescriptionRunResult = {
  lastAssistant: AssistantMessage;
  published: boolean;
  publishSuperseded: boolean;
};

export async function runFullPrDescription(params: {
  cfg: Config;
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  cwd?: string;
  workspace: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  operationIntent?: OperationIntentContext;
  sessionContext?: FeatureSessionContext;
  escalation?: EscalationPlan;
  signal?: AbortSignal;
}): Promise<DescriptionRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.models.provider;
  const setup = buildDescriptionRunSetup(params);
  const { lastText } = await runFeatureAgent(
    {
      state: setup.submitState,
      shouldContinue: () => shouldContinueDescriptionRun(setup),
      userContent: setup.userContent,
      investigation: {
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS_DESCRIBE, params.escalation),
        phase: "description",
        checkpointId: "description:description",
      },
      finalize: {
        maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        phase: "description",
        checkpointId: "description:description",
      },
      nudge: DESCRIPTION_SUBMIT_ONLY_NUDGE,
      nudgeRounds: DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
      repairRounds: DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
      repairPrompt: (validationError) =>
        [
          validationError,
          "Fix the payload and call submitDescription again with a complete DescriptionPayload.",
          `Shape-only example (active map hard rule decides prFiles):\n${JSON.stringify(DESCRIPTION_PAYLOAD_BASE_EXAMPLE, null, 2)}`,
        ].join("\n\n"),
      preserveTextOnNudgeError: true,
    },
    {
      session: {
        role: "description",
        cfg,
        cwd: params.cwd,
        systemPrompt: setup.systemPrompt,
        tools: setup.piTools,
        executors: setup.executors,
        refreshBeforeTool: setup.refreshBeforeTool,
        sessionContext: params.sessionContext,
        attemptModel: params.escalation?.model,
        hostSignal: params.signal,
      },
    },
  );

  if (setup.submitState.published) {
    logInfo("description_run_completed", { owner, repo, pr: prNumber });
  }

  return {
    lastAssistant: assistantFromText(cfg, lastText, providerName),
    published: setup.submitState.published,
    publishSuperseded: setup.submitState.publishSuperseded,
  };
}
