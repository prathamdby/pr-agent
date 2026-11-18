import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toToolParameters } from "../../agent/tools/toolParams.ts";
import { AppError, toAppError } from "../../errors/appError.ts";
import { parseToolInput } from "../../agent/tools/parseToolInput.ts";
import { redactReviewPayloadSecrets } from "../findings/reviewPublicOutput.ts";
import { validateReviewPayload } from "../findings/reviewFindingValidator.ts";
import {
  publishReviewSummaryOnly,
  type PublishSummaryOnlyResult,
} from "../publish/publishSummaryOnly.ts";
import type { PublishStopReason, ReviewPublishSession } from "../publish/reviewPublishSession.ts";
import {
  createReviewPayloadSchema,
  formatReviewValidationError,
  REVIEW_PUBLISH_SUMMARY_FIELDS,
  type ReviewPayload,
} from "../reviewSchema.ts";
import { ledgerFindings, type FindingLedger, type ReviewCoverage } from "./orchestratorTypes.ts";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.ts";
import type { FindingCheck } from "../findingIdentity/findingLifecycle.ts";

const publishSummarySchema = v.pick(createReviewPayloadSchema(), REVIEW_PUBLISH_SUMMARY_FIELDS);

export type PublishSummaryState = {
  published: boolean;
  check: FindingCheck | null;
  lastValidationError: string | null;
  stoppedReason: PublishStopReason | null;
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

type PublishSummaryToolParams = {
  readonly session: ReviewPublishSession;
  readonly phaseRef: OrchestratorPhaseRef;
  readonly state: PublishSummaryState;
  readonly getLedger: () => FindingLedger;
  readonly getCoverage: () => ReviewCoverage;
};

type SummaryInput = v.InferOutput<typeof publishSummarySchema>;

export function createPublishSummaryState(initial?: {
  readonly published?: boolean;
  readonly check?: FindingCheck | null;
}) {
  return ((pinnedReturn: PublishSummaryState) => pinnedReturn)({
    published: initial?.published ?? false,
    check: initial?.check ?? null,
    lastValidationError: null,
    stoppedReason: null,
  });
}

function throwValidationError(
  state: PublishSummaryState,
  kind: "publish_summary_validation_failed" | "publish_summary_semantic_validation_failed",
  message: string,
): never {
  state.lastValidationError = message;
  throw new AppError({ domain: "review", kind, message });
}

function reconstructPayload(
  state: PublishSummaryState,
  ledger: FindingLedger,
  input: SummaryInput,
) {
  const findings = ledgerFindings(ledger);
  const parsed = v.safeParse(createReviewPayloadSchema(), { ...input, findings });
  if (!parsed.success) {
    throwValidationError(
      state,
      "publish_summary_validation_failed",
      `${formatReviewValidationError(parsed.issues).message}\nFindings come from accepted placements, not from publish_summary arguments. Fix only size, followUps, mergeability, or blastRadius here; a findings issue means the ledger itself is invalid.`,
    );
  }
  return ((pinnedReturn: ReviewPayload) => pinnedReturn)(parsed.output);
}

export function buildPublishSummaryTool(params: PublishSummaryToolParams) {
  const { state, getLedger, getCoverage, session } = params;
  const piTool: PiTool = {
    name: "publish_summary",
    description:
      "Publish the final review summary. Call it once, after every specialist batch is judged. You supply size, followUps, mergeability, and blastRadius; the findings come from accepted placements and the server writes the action line. A repeat call after success is a no-op.",
    parameters: toToolParameters(publishSummarySchema),
  };
  const executor = async (args: Record<string, unknown>) => {
    const gate = assertPhaseToolAllowed(params.phaseRef.current, "publish_summary");
    if (!gate.ok) {
      return ((pinnedReturn: PublishSummaryToolResult | Promise<PublishSummaryToolResult>) =>
        pinnedReturn)({
        ok: false,
        code: gate.code,
        phase: gate.phase,
        allowed: gate.allowed,
        error: gate.error,
      });
    }
    if (state.published) {
      return ((pinnedReturn: PublishSummaryToolResult | Promise<PublishSummaryToolResult>) =>
        pinnedReturn)({ ok: true, duplicate: true });
    }

    const parsed = parseToolInput(publishSummarySchema, args, {
      toolName: "publish_summary",
      errorTitle: "publish_summary validation failed:",
    });
    if (!parsed.ok) {
      throwValidationError(state, "publish_summary_validation_failed", parsed.error);
    }

    const ledger = getLedger();
    const candidate = reconstructPayload(state, ledger, parsed.value);
    const validation = validateReviewPayload({
      payload: candidate,
      cachedDiffIndex: session.cachedDiffIndex,
      enforceInlineAnchorValidation: false,
    });
    if (!validation.ok) {
      throwValidationError(state, "publish_summary_semantic_validation_failed", validation.message);
    }

    state.lastValidationError = null;
    const payload = redactReviewPayloadSecrets(candidate);
    let result: PublishSummaryOnlyResult;
    try {
      result = await publishReviewSummaryOnly(session, {
        payload,
        ledger,
        coverage: getCoverage(),
      });
    } catch (error) {
      throw toAppError(error, {
        domain: "review",
        kind: "publish_summary_failed",
        context: {
          owner: session.ctx.owner,
          repo: session.ctx.repo,
          pr: session.ctx.prNumber,
        },
      });
    }
    if (result.kind === "stopped") {
      state.stoppedReason = result.reason;
      return ((pinnedReturn: PublishSummaryToolResult | Promise<PublishSummaryToolResult>) =>
        pinnedReturn)({ ok: false, reason: result.reason });
    }

    state.published = true;
    state.check = result.check;
    state.stoppedReason = null;
    return ((pinnedReturn: PublishSummaryToolResult | Promise<PublishSummaryToolResult>) =>
      pinnedReturn)({ ok: true, summaryCommentId: result.summaryCommentId });
  };

  return ((pinnedReturn: {
    readonly piTool: PiTool;
    readonly executor: (args: Record<string, unknown>) => Promise<PublishSummaryToolResult>;
  }) => pinnedReturn)({ piTool, executor });
}
