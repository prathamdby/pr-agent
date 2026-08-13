import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { parseToolInput } from "../tools/parseToolInput.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import {
  formatTriageValidationError,
  TriagePayloadSchema,
  validateTriageVerdicts,
  type TriagePayload,
} from "../../review/triageSchema.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import type { TriageWorkspaceToolState } from "./triageWorkspaceTools.js";

export type SubmitTriageState = {
  submitted: boolean;
  lastValidationError: string | null;
  payload: TriagePayload | null;
};

export function createSubmitTriageState(): SubmitTriageState {
  return {
    submitted: false,
    lastValidationError: null,
    payload: null,
  };
}

const SUBMIT_TRIAGE_PARAMETERS = toJsonSchema(TriagePayloadSchema, {
  errorMode: "ignore",
});

export type SubmitTriageTool = {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
};

export function buildSubmitTriageTool(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly inventory: readonly BotFindingThread[];
  readonly checkout: WritablePrCheckout;
  readonly workspaceState: TriageWorkspaceToolState;
  readonly submitState: SubmitTriageState;
}): SubmitTriageTool {
  const piTool: PiTool = {
    name: "submitTriage",
    description:
      "Submit exactly one verdict for every triage inventory thread after verifying current code.",
    parameters: SUBMIT_TRIAGE_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    if (params.submitState.submitted) {
      logDebug("triage_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }
    const parsed = parseToolInput(TriagePayloadSchema, args, {
      toolName: "submitTriage",
      errorTitle: "TriagePayload validation failed:",
    });
    if (!parsed.ok) {
      params.submitState.lastValidationError = parsed.error;
      throw new AppError({
        code: "triage.validation_failed",
        message: params.submitState.lastValidationError,
      });
    }
    const issues = validateTriageVerdicts({
      payload: parsed.value,
      inventory: params.inventory.map((thread) => ({
        threadRootCommentId: thread.rootCommentId,
        hasHumanReplies: thread.humanReplies.length > 0,
      })),
      committedShas: params.checkout.listCommittedShas(),
      commitByThreadRootCommentId: params.workspaceState.commitByThreadRootCommentId,
    });
    if (issues.length > 0) {
      params.submitState.lastValidationError = formatTriageValidationError(issues);
      throw new AppError({
        code: "triage.validation_failed",
        message: params.submitState.lastValidationError,
      });
    }

    params.submitState.lastValidationError = null;
    params.submitState.submitted = true;
    params.submitState.payload = parsed.value;
    return { ok: true };
  };

  return { piTool, executor };
}
