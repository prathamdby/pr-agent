import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TriageScope } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
} from "../../agentRun/structuredAgentLoop.js";
import { logInfo } from "../../evlog.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { TriagePayload } from "../../review/triageSchema.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import { createFeaturePiSession } from "../runtime/createFeatureSession.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
import { buildTriageRunSetup, shouldContinueTriageRun } from "./triageRunSetup.js";
import {
  TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS,
  TRIAGE_VALIDATION_REPAIR_ROUNDS,
  MAX_TOOL_ROUNDS_TRIAGE,
} from "../../settings/index.js";

export type TriageRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly submitted: boolean;
  readonly payload: TriagePayload | null;
  readonly commitByThreadRootCommentId: ReadonlyMap<number, string>;
  readonly commitErrors: readonly {
    readonly threadRootCommentId: number;
    readonly error: string;
  }[];
};

/** Shared finalize instruction so nudge + validation-repair wording cannot drift. */
const TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT =
  "call commitFix for each pending finding first, then call submitTriage once with a complete TriagePayload";

const TRIAGE_SUBMIT_ONLY_NUDGE = `You replied with text only. If you have uncommitted workspace edits, ${TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT}.`;

const TRIAGE_VALIDATION_REPAIR_HINT = `If needed, ${TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT}.`;

export async function runFullPrTriage(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly cwd?: string;
  readonly scope?: TriageScope;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly durability?: FeatureSessionDurability;
}): Promise<TriageRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.piProvider;
  const setup = buildTriageRunSetup(params);
  const session = await createFeaturePiSession({
    role: "triage",
    cfg,
    cwd: params.cwd,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
    refreshBeforeTool: params.refreshBeforeTool,
    durability: params.durability,
  });
  let lastText = "";
  const sendFinalizeRound = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, prompt, {
      maxToolRounds: MAX_TOOL_ROUNDS_TRIAGE,
    });

  const runValidationRepair = async () => {
    await runValidationRepairLoop({
      rounds: TRIAGE_VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueTriageRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      repair: async (validationError) => {
        lastText = await sendFinalizeRound(
          [validationError, TRIAGE_VALIDATION_REPAIR_HINT].join("\n\n"),
        );
        // Cap-aborted repair rounds clear lastValidationError before send; restore so
        // remaining repair budget is not forfeited when submit never ran.
        if (!setup.submitState.submitted && setup.submitState.lastValidationError == null) {
          setup.submitState.lastValidationError = validationError;
        }
      },
    });
  };

  try {
    await runStructuredAgentLoop({
      shouldContinue: () => shouldContinueTriageRun(setup),
      phases: [
        {
          name: "investigation",
          run: async () => {
            lastText = (
              await session.send(setup.userContent, {
                maxToolRounds: MAX_TOOL_ROUNDS_TRIAGE,
                phase: "triage",
                checkpointId: "triage:triage",
              })
            ).text;
          },
        },
        {
          name: "pre_submit",
          run: async () => {
            for (
              let nudge = 0;
              nudge < TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS && shouldContinueTriageRun(setup);
              nudge++
            ) {
              lastText = await sendFinalizeRound(TRIAGE_SUBMIT_ONLY_NUDGE);
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
      logInfo("triage_run_completed", { owner, repo, pr: prNumber });
    }

    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      submitted: setup.submitState.submitted,
      payload: setup.submitState.payload,
      commitByThreadRootCommentId: setup.workspaceState.commitByThreadRootCommentId,
      commitErrors: [...setup.workspaceState.commitErrors],
    };
  } finally {
    await session.dispose();
  }
}
