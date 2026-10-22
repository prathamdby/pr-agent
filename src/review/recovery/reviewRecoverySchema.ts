import * as v from "valibot";
import { evidenceDescriptorSchema, OPENED_PATH_MAX_CHARS } from "../findings/evidenceLedger.ts";
import {
  COVERAGE_GAP_CEILINGS,
  reviewFindingEntries,
  reviewFindingSchema,
} from "../reviewSchema.ts";
import { isFindingId, type FindingId } from "../findingIdentity/findingMarker.ts";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const source = v.picklist(["correctness", "security", "quality", "tests", "review"]);
export const findingIdSchema = v.custom<FindingId>(
  (value) => typeof value === "string" && isFindingId(value),
);
const placement = v.object({
  finding: reviewFindingSchema,
  inlineLine: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  inlinePosted: v.boolean(),
  inlineCommentUrl: v.optional(v.string()),
});
const accepted = v.variant("kind", [
  v.strictObject({
    kind: v.picklist(["posted", "resumed"]),
    source,
    placement,
    findingId: findingIdSchema,
    reviewId: count,
    reopens: v.optional(findingIdSchema),
  }),
  v.strictObject({
    kind: v.literal("summary_only"),
    source,
    placement,
    findingId: findingIdSchema,
    reason: v.picklist(["cap", "budget", "anchor", "inventory_incomplete", "unanswered_overlap"]),
    reopens: v.optional(findingIdSchema),
  }),
]);
const reaffirmed = v.strictObject({
  id: findingIdSchema,
  source,
  severity: reviewFindingEntries.severity,
  judged: v.optional(v.boolean()),
  coverageGapCeiling: v.optional(v.picklist(COVERAGE_GAP_CEILINGS)),
  heldBy: v.picklist(["thread", "summary", "run"]),
  placement,
});

export const findingLedgerSnapshotSchema = v.strictObject({
  accepted: v.array(accepted),
  reaffirmed: v.array(reaffirmed),
  suppressedDismissedCount: count,
  inlineReviewIds: v.array(count),
  postedInlineCount: count,
  threadCallCount: count,
  threadBudgetExhausted: v.boolean(),
});
const coverageSpecialistId = v.picklist(["correctness", "security", "quality", "tests"]);
const openedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(OPENED_PATH_MAX_CHARS));
export const UNREAD_COVERAGE_PATH_LIMIT = 500;
const coverageLensList = v.pipe(v.array(coverageSpecialistId), v.minLength(1));
export const reviewCoverageSchema = v.union([
  v.strictObject({ kind: v.literal("full") }),
  v.pipe(
    v.strictObject({
      kind: v.literal("partial"),
      failed: v.optional(coverageLensList),
      paths: v.optional(
        v.pipe(v.array(openedPath), v.minLength(1), v.maxLength(UNREAD_COVERAGE_PATH_LIMIT)),
      ),
      unjudged: v.optional(coverageLensList),
      note: v.string(),
    }),
    v.check(
      (coverage) => coverage.failed != null || coverage.paths != null || coverage.unjudged != null,
      "A partial coverage names a failed specialist, an unread path, or an unjudged lens",
    ),
  ),
  v.strictObject({
    kind: v.literal("none"),
    failed: v.array(coverageSpecialistId),
  }),
]);

export const canonicalReviewDecisionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("threads"),
    source,
    ledgerBefore: findingLedgerSnapshotSchema,
    localDelta: findingLedgerSnapshotSchema,
    inline: v.array(
      v.object({
        ...placement.entries,
        findingId: findingIdSchema,
        reopens: v.optional(findingIdSchema),
        relatedLinks: v.optional(v.array(v.string())),
      }),
    ),
    footers: v.array(v.tuple([v.string(), v.array(v.string())])),
    baseSha: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{40,64}$/)))),
    counts: v.strictObject({ suppressed: count, capDowngraded: count }),
    resultKind: v.picklist(["empty", "budget_exhausted", "remote"]),
    evidence: v.array(evidenceDescriptorSchema),
    judgmentDegraded: v.boolean(),
    briefFallback: v.optional(v.boolean(), false),
    coverage: v.optional(reviewCoverageSchema, { kind: "full" }),
    openedPaths: v.optional(v.pipe(v.array(openedPath), v.maxLength(5000))),
  }),
  v.strictObject({
    kind: v.literal("summary"),
    ledger: findingLedgerSnapshotSchema,
    coverage: reviewCoverageSchema,
    staleReview: v.boolean(),
    judgmentDegraded: v.boolean(),
    briefFallback: v.optional(v.boolean(), false),
  }),
]);
export type CanonicalReviewDecision = v.InferOutput<typeof canonicalReviewDecisionSchema>;
export type CanonicalThreadDecision = Extract<CanonicalReviewDecision, { kind: "threads" }>;
export type FindingLedgerSnapshot = v.InferOutput<typeof findingLedgerSnapshotSchema>;
