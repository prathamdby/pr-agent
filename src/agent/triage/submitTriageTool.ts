import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toToolParameters } from "../tools/toolParams.js";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
import { parseToolInput } from "../tools/parseToolInput.js";
import {
  hasAuthorizedMaintainerDecision,
  type BotFindingThread,
} from "../../review/run/reviewPriorFeedback.js";
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

const SUBMIT_TRIAGE_PARAMETERS = toToolParameters(TriagePayloadSchema);

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
      "Record the triage result: one verdict for every inventory thread, judged against the current code. A fixed verdict cites the full sha that commitFix returned for that thread, and every commitFix commit needs a fixed verdict. A rejected submission returns the reasons; correct them and submit again. The first accepted submission is final.",
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
    const parsed = parseToolInput(TriagePayloadSchema, args, {
      toolName: "submitTriage",
      errorTitle: "TriagePayload validation failed:",
    });
    if (!parsed.ok) {
      params.submitState.lastValidationError = parsed.error;
      throw new AppError({
        domain: "triage",
        kind: "validation_failed",
        message: params.submitState.lastValidationError,
      });
    }
    const issues = validateTriageVerdicts({
      payload: parsed.value,
      inventory: params.inventory.map((thread) => ({
        threadRootCommentId: thread.rootCommentId,
        hasAuthorizedMaintainerDecision: hasAuthorizedMaintainerDecision(thread),
      })),
      committedShas: params.checkout.listCommittedShas(),
      commitByThreadRootCommentId: params.workspaceState.commitByThreadRootCommentId,
    });
    if (issues.length > 0) {
      params.submitState.lastValidationError = formatTriageValidationError(issues);
      throw new AppError({
        domain: "triage",
        kind: "validation_failed",
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
