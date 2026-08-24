import * as v from "valibot";
import {
  MAX_TRIAGE_FINDINGS,
  TRIAGE_SKIP_REASON_MAX_CHARS,
  TRIAGE_VERDICT_EVIDENCE_MAX_CHARS,
} from "../settings/index.js";

const TriageVerdictSchema = v.variant("verdict", [
  v.object({
    verdict: v.literal("fixed"),
    threadRootCommentId: v.pipe(v.number(), v.integer(), v.gtValue(0)),
    commitSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)),
    evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(TRIAGE_VERDICT_EVIDENCE_MAX_CHARS)),
  }),
  v.object({
    verdict: v.literal("already-resolved"),
    threadRootCommentId: v.pipe(v.number(), v.integer(), v.gtValue(0)),
    evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(TRIAGE_VERDICT_EVIDENCE_MAX_CHARS)),
  }),
  v.object({
    verdict: v.literal("skipped"),
    threadRootCommentId: v.pipe(v.number(), v.integer(), v.gtValue(0)),
    reason: v.pipe(v.string(), v.minLength(1), v.maxLength(TRIAGE_SKIP_REASON_MAX_CHARS)),
  }),
  v.object({
    verdict: v.literal("dismissed"),
    threadRootCommentId: v.pipe(v.number(), v.integer(), v.gtValue(0)),
    evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(TRIAGE_VERDICT_EVIDENCE_MAX_CHARS)),
  }),
]);

export const TriagePayloadSchema = v.object({
  verdicts: v.pipe(v.array(TriageVerdictSchema), v.minLength(1), v.maxLength(MAX_TRIAGE_FINDINGS)),
});

export type TriageVerdict = v.InferOutput<typeof TriageVerdictSchema>;
export type TriagePayload = v.InferOutput<typeof TriagePayloadSchema>;

/**
 * Same verdict vocabulary as triage, but read-only.
 * "fixed" cites the user's pushed commit sha (no committed-by-bot check).
 * "dismissed" still requires an authorized maintainer decision for the thread.
 */
const VerificationVerdictSchema = TriageVerdictSchema;

export const VerificationPayloadSchema = v.object({
  verdicts: v.pipe(
    v.array(VerificationVerdictSchema),
    v.minLength(1),
    v.maxLength(MAX_TRIAGE_FINDINGS),
  ),
});

export type VerificationVerdict = v.InferOutput<typeof VerificationVerdictSchema>;
export type VerificationPayload = v.InferOutput<typeof VerificationPayloadSchema>;

type VerificationInventoryItem = {
  readonly threadRootCommentId: number;
  readonly hasAuthorizedMaintainerDecision: boolean;
};

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
