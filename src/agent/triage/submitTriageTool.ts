import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
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
}) as PiTool["parameters"];

export function buildSubmitTriageTool(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly inventory: readonly BotFindingThread[];
  readonly checkout: WritablePrCheckout;
  readonly workspaceState: TriageWorkspaceToolState;
  readonly submitState: SubmitTriageState;
}): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const piTool: PiTool = {
    name: "submitTriage",
    description:
      "Submit exactly one verdict for every triage inventory thread after verifying current code.",
    parameters: SUBMIT_TRIAGE_PARAMETERS,
  };

  const executor = async (args: Record<string, unknown>) => {
    if (params.submitState.submitted) {
      logDebug("triage_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }
    const parsed = v.safeParse(TriagePayloadSchema, args);
    if (!parsed.success) {
      params.submitState.lastValidationError = parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("\n");
      throw new AppError({
        code: "triage.validation_failed",
        message: params.submitState.lastValidationError,
      });
    }
    const issues = validateTriageVerdicts({
      payload: parsed.output,
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
    params.submitState.payload = parsed.output;
    return { ok: true };
  };

  return { piTool, executor };
}
