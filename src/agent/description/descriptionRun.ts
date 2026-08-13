import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
} from "../../agentRun/structuredAgentLoop.js";
import { logInfo } from "../../evlog.js";
import { createFeaturePiSession } from "../runtime/createFeatureSession.js";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "./descriptionSchema.js";
import {
  DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS,
  DESCRIPTION_SUBMIT_ONLY_NUDGE,
  DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
  MAX_TOOL_ROUNDS_DESCRIBE,
} from "../../settings/index.js";
import { buildDescriptionRunSetup, shouldContinueDescriptionRun } from "./descriptionRunSetup.js";
import type { OperationIntentContext } from "../../agentWork/withOperationIntent.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
import type { JsonObject } from "../../util/jsonValue.js";

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
  recordPublishStep?: (detail?: JsonObject) => Promise<void>;
  operationIntent?: OperationIntentContext;
  durability?: FeatureSessionDurability;
}): Promise<DescriptionRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.piProvider;
  const setup = buildDescriptionRunSetup(params);
  const session = await createFeaturePiSession({
    role: "description",
    cfg,
    cwd: params.cwd,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
    refreshBeforeTool: setup.refreshBeforeTool,
    durability: params.durability,
  });
  let lastText = "";

  const sendSubmitOnlyRepair = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, prompt);

  const runValidationRepair = async () => {
    await runValidationRepairLoop({
      rounds: DESCRIPTION_VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueDescriptionRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      repair: async (validationError) => {
        lastText = await sendSubmitOnlyRepair(
          [
            validationError,
            "Fix the payload and call submitDescription again with a complete DescriptionPayload.",
            `Minimal valid example:\n${JSON.stringify(DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
          ].join("\n\n"),
        );
      },
    });
  };

  try {
    await runStructuredAgentLoop({
      shouldContinue: () => shouldContinueDescriptionRun(setup),
      phases: [
        {
          name: "investigation",
          run: async () => {
            lastText = (
              await session.send(setup.userContent, {
                maxToolRounds: MAX_TOOL_ROUNDS_DESCRIBE,
                phase: "description",
                checkpointId: "description:description",
              })
            ).text;
          },
        },
        {
          name: "pre_submit",
          run: async () => {
            for (
              let nudge = 0;
              nudge < DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS && shouldContinueDescriptionRun(setup);
              nudge++
            ) {
              if (setup.submitState.published) break;
              const nudgeText = await sendSubmitOnlyRepair(DESCRIPTION_SUBMIT_ONLY_NUDGE);
              if (!setup.submitState.lastValidationError) {
                lastText = nudgeText;
              }
              await runValidationRepair();
            }
          },
        },
        {
          name: "validation_repair",
          run: async () => {
            if (setup.submitState.lastValidationError) {
              await runValidationRepair();
            }
          },
        },
      ],
    });

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
