import * as v from "valibot";
import {
  MAX_TRIAGE_FINDINGS,
  TRIAGE_SKIP_REASON_MAX_CHARS,
  TRIAGE_VERDICT_EVIDENCE_MAX_CHARS,
  VERIFICATION_OBJECTION_ANSWER_MAX_CHARS,
} from "../settings/index.ts";
import { isUsableReviewTimestamp, type FindingObjection } from "./run/reviewPriorFeedback.ts";

const threadRootCommentIdField = v.pipe(
  v.number(),
  v.integer(),
  v.gtValue(0),
  v.description("Root comment id of the inventory thread this verdict answers."),
);
const evidenceField = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(TRIAGE_VERDICT_EVIDENCE_MAX_CHARS),
  v.description("What in the current code supports this verdict, with file and line."),
);

const TriageVerdictSchema = v.variant("verdict", [
  v.object({
    verdict: v.pipe(
      v.literal("fixed"),
      v.description("A commit in this pull request fixes the finding."),
    ),
    threadRootCommentId: threadRootCommentIdField,
    commitSha: v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{7,40}$/),
      v.description("Full lowercase sha of the fixing commit, exactly as reported."),
    ),
    evidence: evidenceField,
  }),
  v.object({
    verdict: v.pipe(
      v.literal("already-resolved"),
      v.description("The current code no longer has the problem, without a fix from this run."),
    ),
    threadRootCommentId: threadRootCommentIdField,
    evidence: evidenceField,
  }),
  v.object({
    verdict: v.pipe(
      v.literal("skipped"),
      v.description("The finding still applies or cannot be settled from the code available."),
    ),
    threadRootCommentId: threadRootCommentIdField,
    reason: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(TRIAGE_SKIP_REASON_MAX_CHARS),
      v.description("Why the finding was left open."),
    ),
  }),
  v.object({
    verdict: v.pipe(
      v.literal("dismissed"),
      v.description(
        "An authorized maintainer decided the finding does not need a fix. Only valid for threads that record that decision.",
      ),
    ),
    threadRootCommentId: threadRootCommentIdField,
    evidence: evidenceField,
  }),
]);

export const TriagePayloadSchema = v.object({
  verdicts: v.pipe(
    v.array(TriageVerdictSchema),
    v.minLength(1),
    v.maxLength(MAX_TRIAGE_FINDINGS),
    v.description("One verdict for every inventory thread."),
  ),
});

export type TriageVerdict = v.InferOutput<typeof TriageVerdictSchema>;
export type TriagePayload = v.InferOutput<typeof TriagePayloadSchema>;

const VerificationVerdictSchema = TriageVerdictSchema;

const objectionCommentIdField = v.pipe(v.number(), v.integer(), v.gtValue(0));
const objectionUpdatedAtField = v.pipe(
  v.string(),
  v.check((value) => isUsableReviewTimestamp(value), "updatedAt must be a UTC timestamp"),
);
const objectionAnswerBodyField = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(VERIFICATION_OBJECTION_ANSWER_MAX_CHARS),
);

const ObjectionDecisionSchema = v.variant("decision", [
  v.object({
    decision: v.literal("concede"),
    commentId: objectionCommentIdField,
    updatedAt: objectionUpdatedAtField,
    body: objectionAnswerBodyField,
  }),
  v.object({
    decision: v.literal("hold"),
    commentId: objectionCommentIdField,
    updatedAt: objectionUpdatedAtField,
    body: objectionAnswerBodyField,
  }),
  v.object({
    decision: v.literal("not_objection"),
    commentId: objectionCommentIdField,
    updatedAt: objectionUpdatedAtField,
    reason: v.pipe(v.string(), v.minLength(1), v.maxLength(TRIAGE_SKIP_REASON_MAX_CHARS)),
  }),
]);

export const VerificationPayloadSchema = v.object({
  verdicts: v.pipe(
    v.array(VerificationVerdictSchema),
    v.minLength(1),
    v.maxLength(MAX_TRIAGE_FINDINGS),
    v.description("One verdict for every inventory thread."),
  ),
  objectionDecisions: v.optional(v.array(ObjectionDecisionSchema), []),
});

export type VerificationVerdict = v.InferOutput<typeof VerificationVerdictSchema>;
export type VerificationObjectionDecision = v.InferOutput<typeof ObjectionDecisionSchema>;
type ParsedVerificationPayload = v.InferOutput<typeof VerificationPayloadSchema>;
export type VerificationPayload = Omit<ParsedVerificationPayload, "objectionDecisions"> & {
  readonly objectionDecisions?: ParsedVerificationPayload["objectionDecisions"];
};

type VerificationInventoryItem = {
  readonly threadRootCommentId: number;
  readonly hasAuthorizedMaintainerDecision: boolean;
  readonly objections?: readonly FindingObjection[];
};

const OBJECTION_MENTION = /(^|\s)@[A-Za-z0-9]/;

export type VerificationValidationInput = {
  readonly payload: VerificationPayload;
  readonly inventory: readonly VerificationInventoryItem[];
  readonly pushedShas: readonly string[];
};

export function formatVerificationValidationError(issues: readonly string[]): string {
  return ["VerificationPayload validation failed:", ...issues.map((issue) => `- ${issue}`)].join(
    "\n",
  );
}

export function validateVerificationVerdicts(params: VerificationValidationInput): string[] {
  const issues: string[] = [];
  const inventoryById = new Map(params.inventory.map((item) => [item.threadRootCommentId, item]));
  const verdictById = new Map<number, VerificationVerdict>();
  const pushed = params.pushedShas.map((sha) => sha.toLowerCase());

  for (const verdict of params.payload.verdicts) {
    const item = inventoryById.get(verdict.threadRootCommentId);
    if (!item) {
      issues.push(
        `threadRootCommentId ${verdict.threadRootCommentId} is not in the verification inventory`,
      );
      continue;
    }
    if (verdictById.has(verdict.threadRootCommentId)) {
      issues.push(`threadRootCommentId ${verdict.threadRootCommentId} has more than one verdict`);
    }
    verdictById.set(verdict.threadRootCommentId, verdict);
    if (
      verdict.verdict === "fixed" &&
      !pushed.some((full) => full.startsWith(verdict.commitSha.toLowerCase()))
    ) {
      issues.push(`fixed verdict for ${verdict.threadRootCommentId} references an unknown commit`);
    }
    if (verdict.verdict === "dismissed" && !item.hasAuthorizedMaintainerDecision) {
      issues.push(
        `dismissed verdict for ${verdict.threadRootCommentId} requires an authorized maintainer decision`,
      );
    }
  }

  for (const item of params.inventory) {
    if (!verdictById.has(item.threadRootCommentId)) {
      issues.push(`threadRootCommentId ${item.threadRootCommentId} is missing a verdict`);
    }
  }

  const decisions = params.payload.objectionDecisions ?? [];
  const decisionCounts = new Map<number, number>();
  for (const decision of decisions) {
    decisionCounts.set(decision.commentId, (decisionCounts.get(decision.commentId) ?? 0) + 1);
  }
  const reportedDuplicates = new Set<number>();
  const presented = new Map<
    number,
    { readonly item: VerificationInventoryItem; readonly objection: FindingObjection }
  >();
  for (const item of params.inventory) {
    for (const objection of item.objections ?? []) {
      presented.set(objection.commentId, { item, objection });
    }
  }
  for (const decision of decisions) {
    const match = presented.get(decision.commentId);
    if (match == null) {
      issues.push(`objection ${decision.commentId} is not in the verification inventory`);
      continue;
    }
    if (
      (decisionCounts.get(decision.commentId) ?? 0) > 1 &&
      !reportedDuplicates.has(decision.commentId)
    ) {
      reportedDuplicates.add(decision.commentId);
      issues.push(`objection ${decision.commentId} has more than one decision`);
    }
    if (decision.updatedAt !== match.objection.updatedAt) {
      issues.push(`objection ${decision.commentId} updatedAt does not match the candidate`);
    }
    const verdict = verdictById.get(match.item.threadRootCommentId);
    if (verdict == null) continue;
    if (decision.decision === "hold" && verdict.verdict !== "skipped") {
      issues.push(`hold for ${decision.commentId} requires a skipped verdict`);
    }
    if (
      decision.decision === "concede" &&
      verdict.verdict !== "dismissed" &&
      verdict.verdict !== "fixed" &&
      verdict.verdict !== "already-resolved"
    ) {
      issues.push(
        `concede for ${decision.commentId} requires a dismissed, fixed, or already-resolved verdict`,
      );
    }
    if (
      decision.decision === "concede" &&
      verdict.verdict === "dismissed" &&
      (!match.objection.authorized || !match.item.hasAuthorizedMaintainerDecision)
    ) {
      issues.push(
        `concede for ${decision.commentId} cannot dismiss without that candidate's authorized maintainer decision`,
      );
    }
    if (decision.decision !== "not_objection" && OBJECTION_MENTION.test(decision.body)) {
      issues.push(`objection ${decision.commentId} addresses the author by handle`);
    }
  }
  for (const [commentId] of presented) {
    if ((decisionCounts.get(commentId) ?? 0) === 0) {
      issues.push(`objection ${commentId} is missing a decision`);
    }
  }

  return issues;
}

type TriageInventoryItem = {
  readonly threadRootCommentId: number;
  readonly hasAuthorizedMaintainerDecision: boolean;
};

export type TriageValidationInput = {
  readonly payload: TriagePayload;
  readonly inventory: readonly TriageInventoryItem[];
  readonly committedShas: readonly string[];
  readonly commitByThreadRootCommentId?: ReadonlyMap<number, string>;
};

export function formatTriageValidationError(issues: readonly string[]): string {
  return ["TriagePayload validation failed:", ...issues.map((issue) => `- ${issue}`)].join("\n");
}

export function validateTriageVerdicts(params: TriageValidationInput): string[] {
  const issues: string[] = [];
  const inventoryById = new Map(params.inventory.map((item) => [item.threadRootCommentId, item]));
  const verdictById = new Map<number, TriageVerdict>();
  const committed = new Set(params.committedShas.map((sha) => sha.toLowerCase()));

  for (const verdict of params.payload.verdicts) {
    const item = inventoryById.get(verdict.threadRootCommentId);
    if (!item) {
      issues.push(
        `threadRootCommentId ${verdict.threadRootCommentId} is not in the triage inventory`,
      );
      continue;
    }
    if (verdictById.has(verdict.threadRootCommentId)) {
      issues.push(`threadRootCommentId ${verdict.threadRootCommentId} has more than one verdict`);
    }
    verdictById.set(verdict.threadRootCommentId, verdict);
    if (verdict.verdict === "fixed" && !committed.has(verdict.commitSha.toLowerCase())) {
      issues.push(`fixed verdict for ${verdict.threadRootCommentId} references an unknown commit`);
    }
    if (verdict.verdict === "dismissed" && !item.hasAuthorizedMaintainerDecision) {
      issues.push(
        `dismissed verdict for ${verdict.threadRootCommentId} requires an authorized maintainer decision`,
      );
    }
  }

  for (const item of params.inventory) {
    if (!verdictById.has(item.threadRootCommentId)) {
      issues.push(`threadRootCommentId ${item.threadRootCommentId} is missing a verdict`);
    }
  }

  for (const [threadRootCommentId, sha] of params.commitByThreadRootCommentId ?? new Map()) {
    const verdict = verdictById.get(threadRootCommentId);
    if (verdict?.verdict !== "fixed") {
      issues.push(
        `threadRootCommentId ${threadRootCommentId} has commit ${sha} but no fixed verdict`,
      );
    }
  }

  return issues;
}
