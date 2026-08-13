import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { parseToolInput } from "../tools/parseToolInput.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import {
  formatVerificationValidationError,
  VerificationPayloadSchema,
  validateVerificationVerdicts,
  type VerificationPayload,
} from "../../review/triageSchema.js";

export type SubmitVerificationState = {
  submitted: boolean;
  lastValidationError: string | null;
  payload: VerificationPayload | null;
};

export function createSubmitVerificationState(): SubmitVerificationState {
  return {
    submitted: false,
    lastValidationError: null,
    payload: null,
  };
}

const SUBMIT_VERIFICATION_PARAMETERS = toJsonSchema(VerificationPayloadSchema, {
  errorMode: "ignore",
});

export type SubmitVerificationTool = {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
};

export function buildSubmitVerificationTool(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedShas: readonly string[];
  readonly submitState: SubmitVerificationState;
}): SubmitVerificationTool {
  const piTool: PiTool = {
    name: "submitVerification",
    description:
      "Submit exactly one verdict for every verification inventory thread after inspecting current code.",
    parameters: SUBMIT_VERIFICATION_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    if (params.submitState.submitted) {
      logDebug("verification_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }
    const parsed = parseToolInput(VerificationPayloadSchema, args, {
      toolName: "submitVerification",
      errorTitle: "VerificationPayload validation failed:",
    });
    if (!parsed.ok) {
      params.submitState.lastValidationError = parsed.error;
      throw new AppError({
        code: "verification.validation_failed",
        message: params.submitState.lastValidationError,
      });
    }
    const issues = validateVerificationVerdicts({
      payload: parsed.value,
      inventory: params.inventory.map((thread) => ({
        threadRootCommentId: thread.rootCommentId,
        hasHumanReplies: thread.humanReplies.length > 0,
      })),
      pushedShas: params.pushedShas,
    });
    if (issues.length > 0) {
      params.submitState.lastValidationError = formatVerificationValidationError(issues);
      throw new AppError({
        code: "verification.validation_failed",
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
