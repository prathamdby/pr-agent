import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
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
}) as PiTool["parameters"];

export function buildSubmitVerificationTool(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedShas: readonly string[];
  readonly submitState: SubmitVerificationState;
}): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const piTool: PiTool = {
    name: "submitVerification",
    description:
      "Submit exactly one verdict for every verification inventory thread after inspecting current code.",
    parameters: SUBMIT_VERIFICATION_PARAMETERS,
  };

  const executor = async (args: Record<string, unknown>) => {
    if (params.submitState.submitted) {
      logDebug("verification_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }
    const parsed = v.safeParse(VerificationPayloadSchema, args);
    if (!parsed.success) {
      params.submitState.lastValidationError = parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("\n");
      throw new AppError({
        code: "verification.validation_failed",
        message: params.submitState.lastValidationError,
      });
    }
    const issues = validateVerificationVerdicts({
      payload: parsed.output,
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
    params.submitState.payload = parsed.output;
    return { ok: true };
  };

  return { piTool, executor };
}
