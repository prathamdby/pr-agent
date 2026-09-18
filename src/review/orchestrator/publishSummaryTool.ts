import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AppError, toAppError } from "../../errors/appError.js";
import { parseToolInput } from "../../agent/tools/parseToolInput.js";
import { redactReviewPayloadSecrets } from "../findings/reviewPublicOutput.js";
import { validateReviewPayload } from "../findings/reviewFindingValidator.js";
import {
  publishReviewSummaryOnly,
  type PublishSummaryOnlyResult,
} from "../publish/publishSummaryOnly.js";
import {
  createReviewPayloadSchema,
  formatReviewValidationError,
  REVIEW_PUBLISH_SUMMARY_FIELDS,
  type ReviewPayload,
} from "../reviewSchema.js";
import type { FindingLedger, ReviewCoverage } from "./orchestratorTypes.js";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.js";

// Derived from the payload schema: synthesis authors these gates; findings stay ledger-owned.
const publishSummarySchema = v.pick(createReviewPayloadSchema(), REVIEW_PUBLISH_SUMMARY_FIELDS);

export type PublishSummaryState = {
  published: boolean;
  lastValidationError: string | null;
  stoppedReason: "superseded" | "stale_head" | null;
};

export type PublishSummaryToolResult =
  | { readonly ok: true; readonly summaryCommentId: number }
  | { readonly ok: true; readonly duplicate: true }
  | {
      readonly ok: false;
      readonly reason: Extract<PublishSummaryOnlyResult, { readonly kind: "stopped" }>["reason"];
    }
  | {
      readonly ok: false;
      readonly code: "review.tool_wrong_phase";
      readonly phase: string;
      readonly allowed: readonly string[];
      readonly error: string;
    };

type PublishSummaryToolParams = Omit<
  Parameters<typeof publishReviewSummaryOnly>[0],
  "payload" | "ledger" | "coverage"
> & {
  readonly phaseRef: OrchestratorPhaseRef;
  readonly state: PublishSummaryState;
  readonly getLedger: () => FindingLedger;
  readonly getCoverage: () => ReviewCoverage;
};

type SummaryInput = v.InferOutput<typeof publishSummarySchema>;

export function createPublishSummaryState(initial?: {
  readonly published?: boolean;
}): PublishSummaryState {
  return {
    published: initial?.published ?? false,
    lastValidationError: null,
    stoppedReason: null,
  };
}

function throwValidationError(
  state: PublishSummaryState,
  code:
    | "review.publish_summary_validation_failed"
    | "review.publish_summary_semantic_validation_failed",
  message: string,
): never {
  state.lastValidationError = message;
  throw new AppError({ code, message });
}

function reconstructPayload(
  state: PublishSummaryState,
  ledger: FindingLedger,
  input: SummaryInput,
): ReviewPayload {
  const findings = ledger.accepted.map((accepted) => accepted.placement.finding);
  const parsed = v.safeParse(createReviewPayloadSchema(), { ...input, findings });
  if (!parsed.success) {
    throwValidationError(
      state,
      "review.publish_summary_validation_failed",
      formatReviewValidationError(parsed.issues).message,
    );
  }
  return parsed.output;
}

export function buildPublishSummaryTool(params: PublishSummaryToolParams): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<PublishSummaryToolResult>;
} {
  const { state, getLedger, getCoverage, ...publishContext } = params;
  const piTool: PiTool = {
    name: "publish_summary",
    description:
      "Publish the final review summary exactly once. Set size, followUps, mergeability, and blastRadius; findings publish from accepted placements. The server writes the action line.",
    parameters: toJsonSchema(publishSummarySchema, { errorMode: "ignore" }),
  };
  const executor = async (args: Record<string, unknown>): Promise<PublishSummaryToolResult> => {
    const gate = assertPhaseToolAllowed(params.phaseRef.current, "publish_summary");
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.code,
        phase: gate.phase,
        allowed: gate.allowed,
        error: gate.error,
      };
    }
    if (state.published) {
      return { ok: true, duplicate: true };
    }

    const parsed = parseToolInput(publishSummarySchema, args, {
      toolName: "publish_summary",
      errorTitle: "publish_summary validation failed:",
    });
    if (!parsed.ok) {
      throwValidationError(state, "review.publish_summary_validation_failed", parsed.error);
    }

    const ledger = getLedger();
    const candidate = reconstructPayload(state, ledger, parsed.value);
    const validation = validateReviewPayload({
      payload: candidate,
      cachedDiffIndex: params.cachedDiffIndex,
      enforceInlineAnchorValidation: false,
    });
    if (!validation.ok) {
      throwValidationError(
        state,
        "review.publish_summary_semantic_validation_failed",
        validation.message,
      );
    }

    state.lastValidationError = null;
    const payload = redactReviewPayloadSecrets(candidate);
    let result: PublishSummaryOnlyResult;
    try {
      result = await publishReviewSummaryOnly({
        ...publishContext,
        payload,
        ledger,
        coverage: getCoverage(),
      });
    } catch (error) {
      throw toAppError(error, {
        code: "review.publish_summary_failed",
        context: {
          owner: params.ctx.owner,
          repo: params.ctx.repo,
          pr: params.ctx.prNumber,
        },
      });
    }
    if (result.kind === "stopped") {
      state.stoppedReason = result.reason;
      return { ok: false, reason: result.reason };
    }

    state.published = true;
    state.stoppedReason = null;
    return { ok: true, summaryCommentId: result.summaryCommentId };
  };

  return { piTool, executor };
}
