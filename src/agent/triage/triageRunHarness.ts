import type { TriageScope } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
} from "../../agentRun/structuredAgentLoop.js";
import { logInfo } from "../../evlog.js";
import { createFeaturePiSession } from "../runtime/createFeatureSession.js";
import type { TriageRunResult } from "./triageRun.js";
import {
  buildSubmitOnlyTriageSessionTools,
  buildTriageRunSetup,
  shouldContinueTriageRun,
} from "./triageRunSetup.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
import {
  TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS,
  TRIAGE_VALIDATION_REPAIR_ROUNDS,
  MAX_TOOL_ROUNDS_TRIAGE,
} from "../../settings/index.js";

const TRIAGE_SUBMIT_ONLY_NUDGE =
  "You replied with text only. If you have uncommitted workspace edits, call commitFix for each finding first, then call submitTriage once with a complete TriagePayload.";

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
    durability: params.durability,
  });
  let lastText = "";
  const sendFinalizeRound = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, buildSubmitOnlyTriageSessionTools(setup), prompt, (active, text) =>
      active.send(text, {
        phase: "triage",
        checkpointId: "triage:triage",
        maxToolRounds: MAX_TOOL_ROUNDS_TRIAGE,
      }),
    );

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
          [
            validationError,
            "If needed, commitFix pending edits, then call submitTriage again with a complete TriagePayload.",
          ].join("\n\n"),
        );
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
    };
  } finally {
    await session.dispose();
  }
}
