import type { Pool } from "pg";
import { isCheckFailingSeverity, type ReviewFinding } from "../review/reviewSchema.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";
import type { OwnVerdictOutcome } from "./closeOwnVerdict.js";
import { getCompletedPublishStepDetail } from "./publishRecordRepository.js";

export type TerminalOwnCheckStatus = "completed" | "failed" | "cancelled" | "superseded";

/** GitHub finish is in `detail`, not `publish_records.status`. */
export function isOwnCheckOpen(detail: Record<string, unknown> | null): boolean {
  if (detail == null) return true;
  if (detail.status === "in_progress") return true;
  return typeof detail.conclusion !== "string" || detail.conclusion.length === 0;
}

export function asTerminalOwnCheckStatus(status: string): TerminalOwnCheckStatus | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return status;
    default:
      return null;
  }
}

export function summaryCommentVerdictMeta(params: {
  readonly kind: "published" | "partial";
  readonly note?: string;
  readonly findings: readonly Pick<ReviewFinding, "severity">[];
}): {
  readonly ownVerdictKind: "published" | "partial";
  readonly ownVerdictNote?: string;
  readonly ownCheckFailing: boolean;
} {
  const ownCheckFailing = params.findings.some((finding) =>
    isCheckFailingSeverity(finding.severity),
  );
  if (params.kind === "partial") {
    return {
      ownVerdictKind: "partial",
      ...(params.note != null && params.note.length > 0 ? { ownVerdictNote: params.note } : {}),
      ownCheckFailing,
    };
  }
  return { ownVerdictKind: "published", ownCheckFailing };
}

export function ownVerdictFromSummaryDetail(
  detail: Record<string, unknown> | null,
): OwnVerdictOutcome {
  if (detail == null) return { kind: "not_published" };
  if (detail.ownVerdictKind === "partial") {
    const note =
      typeof detail.ownVerdictNote === "string" && detail.ownVerdictNote.length > 0
        ? detail.ownVerdictNote
        : "Partial specialist coverage.";
    return { kind: "partial", note };
  }
  const findings: readonly Pick<ReviewFinding, "severity">[] =
    detail.ownCheckFailing === true ? [{ severity: "P1" }] : [];
  return { kind: "published", findings };
}

export async function resolveOwnVerdictForTerminalReview(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly status: TerminalOwnCheckStatus;
}): Promise<OwnVerdictOutcome> {
  switch (params.status) {
    case "failed":
      return { kind: "crashed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "superseded":
      return { kind: "superseded" };
    case "completed": {
      const summary = await getCompletedPublishStepDetail(
        params.pool,
        params.workItemId,
        params.resourceKey,
        params.reviewLens,
        "summary_comment",
      );
      if (summary == null) return { kind: "not_published" };
      return ownVerdictFromSummaryDetail(summary);
    }
    default: {
      const _exhaustive: never = params.status;
      return _exhaustive;
    }
  }
}
