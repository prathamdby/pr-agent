import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { AppError, nonErrorThrown, toAppError } from "../../errors/appError.js";
import { MAX_REVIEW_PAYLOAD_FINDINGS } from "../../settings/index.js";
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
  reviewFindingEntries,
  type ReviewFinding,
  type ReviewPayload,
} from "../reviewSchema.js";
import type { AcceptedPlacement, FindingLedger, ReviewCoverage } from "./orchestratorTypes.js";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.js";

const summaryFindingCopySchema = v.object({
  findingId: v.pipe(v.string(), v.minLength(1)),
  title: reviewFindingEntries.title,
  detail: reviewFindingEntries.detail,
  fixPrompt: reviewFindingEntries.fixPrompt,
  confidence: reviewFindingEntries.confidence,
  category: reviewFindingEntries.category,
});

const publishSummarySchema = v.object({
  ...v.omit(createReviewPayloadSchema(), ["findings"]).entries,
  findings: v.pipe(v.array(summaryFindingCopySchema), v.maxLength(MAX_REVIEW_PAYLOAD_FINDINGS)),
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
type SummaryFindingCopy = v.InferOutput<typeof summaryFindingCopySchema>;

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
  const finding: ReviewFinding = {
    severity: immutable.severity,
    file: immutable.file,
    startLine: immutable.startLine,
    endLine: immutable.endLine,
    title: copy.title,
    detail: copy.detail,
  };
  if (copy.fixPrompt != null) finding.fixPrompt = copy.fixPrompt;
  if (copy.confidence != null) finding.confidence = copy.confidence;
  if (copy.category != null) finding.category = copy.category;
  return finding;
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
  const parsed = v.safeParse(createReviewPayloadSchema(), { ...overview, findings });
  if (!parsed.success) {
    throwValidationError(
      state,
      "review.publish_summary_validation_failed",
      formatReviewValidationError(parsed.issues).message,
    );
  }
  return parsed.output;
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

export type PublishSummaryTool = {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
};

export function buildPublishSummaryTool(params: PublishSummaryToolParams): PublishSummaryTool {
  const { state, getLedger, getCoverage, ...publishContext } = params;
  const piTool: PiTool = {
    name: "publish_summary",
    description:
      "Publish the final review summary exactly once. Supply display copy for every accepted finding ID without changing severity or placement. Write prCharacter per the synthesis overview-scale hard rule.",
    parameters: toJsonSchema(publishSummarySchema, { errorMode: "ignore" }),
  };
  const executor: AgentRunnerToolExecutor = async (args) => {
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
      const err = error instanceof Error ? error : nonErrorThrown("review.publish_summary_failed");
      throw toAppError(err, {
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
