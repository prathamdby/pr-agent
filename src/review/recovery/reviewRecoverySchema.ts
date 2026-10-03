import * as v from "valibot";
import { evidenceDescriptorSchema } from "../findings/evidenceLedger.js";
import { reviewFindingSchema } from "../reviewSchema.js";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const source = v.picklist(["correctness", "security", "quality", "tests", "review"]);
const placement = v.object({
  finding: reviewFindingSchema,
  inlineLine: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  inlinePosted: v.boolean(),
  inlineCommentUrl: v.optional(v.string()),
  inlineFingerprint: v.optional(v.string()),
});
const accepted = v.variant("kind", [
  v.strictObject({
    kind: v.picklist(["posted", "resumed"]),
    source,
    placement,
    canonicalFingerprint: v.string(),
    reviewId: count,
  }),
  v.strictObject({
    kind: v.literal("summary_only"),
    source,
    placement,
    canonicalFingerprint: v.string(),
    reason: v.picklist(["historical", "cap", "budget", "anchor"]),
  }),
]);

/** Canonical deltas stay in budgeted prepared rows, never the settlement reserve. */
export const findingLedgerSnapshotSchema = v.strictObject({
  accepted: v.array(accepted),
  suppressionFingerprints: v.array(v.string()),
  inlineReviewIds: v.array(count),
  postedInlineCount: count,
  threadCallCount: count,
  threadBudgetExhausted: v.boolean(),
});
export const reviewCoverageSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("full") }),
  v.strictObject({
    kind: v.literal("partial"),
    failed: v.array(v.picklist(["correctness", "security", "quality", "tests"])),
    note: v.string(),
  }),
  v.strictObject({
    kind: v.literal("none"),
    failed: v.array(v.picklist(["correctness", "security", "quality", "tests"])),
  }),
]);

export const canonicalReviewDecisionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("threads"),
    source,
    ledgerBefore: findingLedgerSnapshotSchema,
    localDelta: findingLedgerSnapshotSchema,
    inline: v.array(v.object({ ...placement.entries, inlineFingerprint: v.string() })),
    footers: v.array(v.tuple([v.string(), v.array(v.string())])),
    counts: v.strictObject({ suppressed: count, capDowngraded: count }),
    resultKind: v.picklist(["empty", "budget_exhausted", "remote"]),
    evidence: v.array(evidenceDescriptorSchema),
    judgmentDegraded: v.boolean(),
    briefFallback: v.optional(v.boolean(), false),
    coverage: v.optional(reviewCoverageSchema, { kind: "full" }),
  }),
  v.strictObject({
    kind: v.literal("summary"),
    ledger: findingLedgerSnapshotSchema,
    coverage: reviewCoverageSchema,
    staleReview: v.boolean(),
    dedupedFindingCount: count,
    judgmentDegraded: v.boolean(),
    briefFallback: v.optional(v.boolean(), false),
  }),
]);
export type CanonicalReviewDecision = v.InferOutput<typeof canonicalReviewDecisionSchema>;
export type CanonicalThreadDecision = Extract<CanonicalReviewDecision, { kind: "threads" }>;
export type FindingLedgerSnapshot = v.InferOutput<typeof findingLedgerSnapshotSchema>;
