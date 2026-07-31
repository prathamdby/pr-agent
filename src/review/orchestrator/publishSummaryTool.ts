import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AppError, toAppError } from "../../errors/appError.js";
import { MAX_REVIEW_PAYLOAD_FINDINGS } from "../../settings/index.js";
import { formatZodIssues } from "../../util/formatZodIssues.js";
import { redactReviewPayloadSecrets } from "../findings/reviewPublicOutput.js";
import { validateReviewPayload } from "../findings/reviewFindingValidator.js";
import {
  publishReviewSummaryOnly,
  type PublishSummaryOnlyResult,
} from "../publish/publishSummaryOnly.js";
import {
  createReviewPayloadSchema,
  formatReviewValidationError,
  reviewFindingSchema,
  type ReviewFinding,
  type ReviewPayload,
} from "../reviewSchema.js";
import type { AcceptedPlacement, FindingLedger, ReviewCoverage } from "./orchestratorTypes.js";

const summaryFindingCopySchema = z.object({
  findingId: z.string().min(1),
  title: reviewFindingSchema.shape.title,
  detail: reviewFindingSchema.shape.detail,
  fixPrompt: reviewFindingSchema.shape.fixPrompt,
  confidence: reviewFindingSchema.shape.confidence,
  category: reviewFindingSchema.shape.category,
});

const publishSummarySchema = createReviewPayloadSchema()
  .omit({ findings: true })
  .extend({
    findings: z.array(summaryFindingCopySchema).max(MAX_REVIEW_PAYLOAD_FINDINGS),
  });

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
    };

type PublishSummaryToolParams = Omit<
  Parameters<typeof publishReviewSummaryOnly>[0],
  "payload" | "ledger" | "coverage"
> & {
  readonly state: PublishSummaryState;
  readonly getLedger: () => FindingLedger;
  readonly getCoverage: () => ReviewCoverage;
};

type SummaryInput = z.infer<typeof publishSummarySchema>;
type SummaryFindingCopy = z.infer<typeof summaryFindingCopySchema>;

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

function validateFindingIds(
  state: PublishSummaryState,
  ledger: FindingLedger,
  copies: readonly SummaryFindingCopy[],
): void {
  const acceptedIds = ledger.accepted.map((accepted) => accepted.canonicalFingerprint);
  const suppliedIds = copies.map((copy) => copy.findingId);
  const acceptedSet = new Set(acceptedIds);
  const suppliedSet = new Set(suppliedIds);
  const duplicateAccepted = acceptedIds.filter(
    (findingId, index) => acceptedIds.indexOf(findingId) !== index,
  );
  const duplicateSupplied = suppliedIds.filter(
    (findingId, index) => suppliedIds.indexOf(findingId) !== index,
  );
  const missing = acceptedIds.filter((findingId) => !suppliedSet.has(findingId));
  const unknown = suppliedIds.filter((findingId) => !acceptedSet.has(findingId));

  if (
    duplicateAccepted.length === 0 &&
    duplicateSupplied.length === 0 &&
    missing.length === 0 &&
    unknown.length === 0 &&
    acceptedIds.length === suppliedIds.length
  ) {
    return;
  }

  const details = [
    duplicateAccepted.length > 0
      ? `ledger duplicate IDs: ${[...new Set(duplicateAccepted)].join(", ")}`
      : null,
    duplicateSupplied.length > 0
      ? `duplicate IDs: ${[...new Set(duplicateSupplied)].join(", ")}`
      : null,
    missing.length > 0 ? `missing IDs: ${[...new Set(missing)].join(", ")}` : null,
    unknown.length > 0 ? `unknown IDs: ${[...new Set(unknown)].join(", ")}` : null,
  ].filter((detail) => detail != null);
  throwValidationError(
    state,
    "review.publish_summary_validation_failed",
    [
      "publish_summary finding IDs must include every accepted canonicalFingerprint exactly once.",
      ...details,
    ].join("\n"),
  );
}

function findingFromCopy(accepted: AcceptedPlacement, copy: SummaryFindingCopy): ReviewFinding {
  const immutable = accepted.placement.finding;
  return {
    severity: immutable.severity,
    file: immutable.file,
    startLine: immutable.startLine,
    endLine: immutable.endLine,
    title: copy.title,
    detail: copy.detail,
    ...(copy.fixPrompt == null ? {} : { fixPrompt: copy.fixPrompt }),
    ...(copy.confidence == null ? {} : { confidence: copy.confidence }),
    ...(copy.category == null ? {} : { category: copy.category }),
  };
}

function reconstructPayload(
  state: PublishSummaryState,
  ledger: FindingLedger,
  input: SummaryInput,
): ReviewPayload {
  validateFindingIds(state, ledger, input.findings);
  const copiesById = new Map(input.findings.map((copy) => [copy.findingId, copy]));
  const findings = ledger.accepted.map((accepted) => {
    const copy = copiesById.get(accepted.canonicalFingerprint);
    if (!copy) {
      throw new AppError({
        code: "review.publish_summary_finding_copy_missing",
        message: "Validated publish_summary input lost an accepted finding copy",
        context: { findingId: accepted.canonicalFingerprint },
      });
    }
    return findingFromCopy(accepted, copy);
  });
  const { findings: _copies, ...overview } = input;
  const parsed = createReviewPayloadSchema().safeParse({ ...overview, findings });
  if (!parsed.success) {
    throwValidationError(
      state,
      "review.publish_summary_validation_failed",
      formatReviewValidationError(parsed.error).message,
    );
  }
  return parsed.data;
}

function ledgerWithFindingCopy(
  ledger: FindingLedger,
  findings: readonly ReviewFinding[],
): FindingLedger {
  return {
    ...ledger,
    accepted: ledger.accepted.map((accepted, index) => {
      const finding = findings[index];
      if (!finding) {
        throw new AppError({
          code: "review.publish_summary_finding_copy_missing",
          message: "Validated publish_summary payload lost a ledger finding",
          context: { findingId: accepted.canonicalFingerprint },
        });
      }
      return {
        ...accepted,
        placement: { ...accepted.placement, finding },
      };
    }),
  };
}

export function buildPublishSummaryTool(params: PublishSummaryToolParams): {
  readonly piTool: PiTool;
  readonly executor: (args: Record<string, unknown>) => Promise<PublishSummaryToolResult>;
} {
  const { state, getLedger, getCoverage, ...publishContext } = params;
  const piTool: PiTool = {
    name: "publish_summary",
    description:
      "Publish the final review summary exactly once. Supply display copy for every accepted finding ID without changing severity or placement.",
    parameters: z.toJSONSchema(publishSummarySchema),
  };
  const executor = async (args: Record<string, unknown>): Promise<PublishSummaryToolResult> => {
    if (state.published) {
      return { ok: true, duplicate: true };
    }

    const parsed = publishSummarySchema.safeParse(args);
    if (!parsed.success) {
      throwValidationError(
        state,
        "review.publish_summary_validation_failed",
        formatZodIssues(parsed.error, "publish_summary validation failed:"),
      );
    }

    const ledger = getLedger();
    const candidate = reconstructPayload(state, ledger, parsed.data);
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
    const summaryLedger = ledgerWithFindingCopy(ledger, payload.findings);
    let result: PublishSummaryOnlyResult;
    try {
      result = await publishReviewSummaryOnly({
        ...publishContext,
        payload,
        ledger: summaryLedger,
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
