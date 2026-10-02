import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TriageScope } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import { logInfo } from "../../evlog.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { TriagePayload } from "../../review/triageSchema.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import { assistantFromText, runFeatureAgent } from "../runtime/featureAgent.js";
import type { FeatureSessionContext } from "../runtime/createFeatureSession.js";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.js";
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
  readonly sessionContext?: FeatureSessionContext;
  readonly escalation?: EscalationPlan;
  readonly signal?: AbortSignal;
}): Promise<TriageRunResult> {
  const { cfg, owner, repo, prNumber } = params;
  const providerName = cfg.piProvider;
  const setup = buildTriageRunSetup(params);
  const { lastText } = await runFeatureAgent(
    {
      state: setup.submitState,
      shouldContinue: () => shouldContinueTriageRun(setup),
      userContent: setup.userContent,
      investigation: {
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS_TRIAGE, params.escalation),
        phase: "triage",
        checkpointId: "triage:triage",
      },
      finalize: {
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS_TRIAGE, params.escalation),
        phase: "triage",
        checkpointId: "triage:triage",
      },
      nudge: TRIAGE_SUBMIT_ONLY_NUDGE,
      nudgeRounds: TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS,
      repairRounds: TRIAGE_VALIDATION_REPAIR_ROUNDS,
      repairPrompt: (validationError) =>
        [validationError, TRIAGE_VALIDATION_REPAIR_HINT].join("\n\n"),
    },
    {
      session: {
        role: "triage",
        cfg,
        cwd: params.cwd,
        systemPrompt: setup.systemPrompt,
        tools: setup.piTools,
        executors: setup.executors,
        refreshBeforeTool: params.refreshBeforeTool,
        sessionContext: params.sessionContext,
        attemptModel: params.escalation?.model,
        hostSignal: params.signal,
      },
    },
  );

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
}
