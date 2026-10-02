import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Config,
  SUBMIT_ONLY_MAX_TOOL_ROUNDS,
  VERIFICATION_PRE_SUBMIT_NUDGE_ROUNDS,
  VERIFICATION_VALIDATION_REPAIR_ROUNDS,
  MAX_TOOL_ROUNDS_VERIFICATION,
} from "../../settings/index.js";
import { logInfo } from "../../evlog.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { VerificationPayload } from "../../review/triageSchema.js";
import { assistantFromText, runFeatureAgent } from "../runtime/featureAgent.js";
import type { FeatureSessionContext } from "../runtime/createFeatureSession.js";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.js";
import {
  buildVerificationRunSetup,
  shouldContinueVerificationRun,
} from "./verificationRunSetup.js";

export type VerificationRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly submitted: boolean;
  readonly payload: VerificationPayload | null;
};

const VERIFICATION_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitVerification now with a complete VerificationPayload.";

export async function runVerification(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly workspace: LocalPrWorkspace;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly compareFilesTruncated?: boolean;
  readonly sessionContext?: FeatureSessionContext;
  /** Escalation for attempts after the first; undefined leaves the base budget. */
  readonly escalation?: EscalationPlan;
  readonly signal?: AbortSignal;
}): Promise<VerificationRunResult> {
  const { cfg, owner, repo, prNumber, escalation } = params;
  const providerName = cfg.models.provider;
  const setup = buildVerificationRunSetup(params);
  const { lastText } = await runFeatureAgent(
    {
      state: setup.submitState,
      shouldContinue: () => shouldContinueVerificationRun(setup),
      userContent: setup.userContent,
      investigation: {
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS_VERIFICATION, escalation),
        phase: "verification",
        checkpointId: "verification:verification",
      },
      finalize: {
        maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        phase: "verification",
        checkpointId: "verification:verification",
      },
      nudge: VERIFICATION_SUBMIT_ONLY_NUDGE,
      nudgeRounds: VERIFICATION_PRE_SUBMIT_NUDGE_ROUNDS,
      repairRounds: VERIFICATION_VALIDATION_REPAIR_ROUNDS,
      repairPrompt: (validationError) =>
        [validationError, "Fix the payload and call submitVerification again."].join("\n\n"),
    },
    {
      session: {
        role: "verification",
        cfg,
        cwd: params.workspace.agentCwd,
        systemPrompt: setup.systemPrompt,
        tools: setup.piTools,
        executors: setup.executors,
        sessionContext: params.sessionContext,
        attemptModel: escalation?.model,
        hostSignal: params.signal,
      },
    },
  );

  if (setup.submitState.submitted) {
    logInfo("verification_run_completed", { owner, repo, pr: prNumber });
  }

  return {
    lastAssistant: assistantFromText(cfg, lastText, providerName),
    submitted: setup.submitState.submitted,
    payload: setup.submitState.payload,
  };
}
