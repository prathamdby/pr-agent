import { REVIEW_SEVERITY_RANK } from "../settings.js";
import { redactOutboundSecrets } from "../security.js";
import { dedupeReviewFindings } from "./reviewFindingDedup.js";
import type { AnchorFailure } from "./reviewFindingValidator.js";
import { validateReviewPayload } from "./reviewFindingValidator.js";
import {
  normalizeReviewPayload,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPayload,
} from "./reviewSchema.js";
import type { CachedPrDiffIndex } from "./reviewDiffIndex.js";
import type { InlinePlacement } from "./reviewDiffPlacement.js";

export type PreparedReviewPayload = {
  readonly payload: ReviewPayload;
  readonly dedupedCount: number;
  readonly placements: readonly InlinePlacement[];
};

function redactReviewPayloadSecrets(payload: ReviewPayload): ReviewPayload {
  return {
    ...payload,
    prCharacter: redactOutboundSecrets(payload.prCharacter),
    securityConcerns:
      payload.securityConcerns == null ? null : redactOutboundSecrets(payload.securityConcerns),
    followUps: payload.followUps.map((item) => redactOutboundSecrets(item)),
    findings: payload.findings.map((finding) => ({
      ...finding,
      title: redactOutboundSecrets(finding.title),
      detail: redactOutboundSecrets(finding.detail),
      fixPrompt:
        finding.fixPrompt == null ? finding.fixPrompt : redactOutboundSecrets(finding.fixPrompt),
      suggestedCode:
        finding.suggestedCode == null
          ? finding.suggestedCode
          : redactOutboundSecrets(finding.suggestedCode),
    })),
  };
}

function passesSeverityFloor(severity: ReviewFinding["severity"], severityFloor?: number): boolean {
  if (severityFloor == null) return true;
  return REVIEW_SEVERITY_RANK[severity] <= severityFloor;
}

export function prepareReviewPayloadForPublish(params: {
  payload: ReviewPayload;
  mode: ReviewMode;
  reviewMinConfidence?: number;
  severityFloor?: number;
  cachedDiffIndex?: CachedPrDiffIndex;
  enforceInlineAnchorValidation?: boolean;
}):
  | { ok: true; prepared: PreparedReviewPayload }
  | { ok: false; error: string; anchorFailures: readonly AnchorFailure[] } {
  const normalized = normalizeReviewPayload(params.payload);
  const deduped = dedupeReviewFindings(normalized.findings);
  const minConfidence = params.reviewMinConfidence ?? 1;
  const confidenceFiltered = deduped.filter(
    (finding) => finding.confidence == null || finding.confidence >= minConfidence,
  );
  const severityFiltered = confidenceFiltered.filter((finding) =>
    passesSeverityFloor(finding.severity, params.severityFloor),
  );
  const candidate = { ...normalized, findings: severityFiltered };
  const dedupedCount = normalized.findings.length - deduped.length;

  const validation = validateReviewPayload({
    payload: candidate,
    cachedDiffIndex: params.cachedDiffIndex,
    enforceInlineAnchorValidation: params.enforceInlineAnchorValidation,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.message,
      anchorFailures: validation.anchorFailures,
    };
  }

  const payload = redactReviewPayloadSecrets(candidate);
  // Redaction maps findings 1:1 (order and count preserved, only text fields change),
  // so realign the already-validated placements onto the redacted findings by index.
  const placements = validation.placements.map((placement, index) => ({
    ...placement,
    finding: payload.findings[index] ?? placement.finding,
  }));
  return {
    ok: true,
    prepared: { payload, dedupedCount, placements },
  };
}
