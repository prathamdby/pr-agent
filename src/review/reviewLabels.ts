import { LABEL_REVIEW_EFFORT_PREFIX, LABEL_SECURITY_CONCERN } from "../settings/index.js";
import type { ReviewPayload } from "./reviewSchema.js";

export function labelsAlreadySynced(
  currentLabels: string[],
  payload: ReviewPayload,
  opts: { effort: boolean; security: boolean },
): boolean {
  if (opts.effort) {
    const effortLabel = `${LABEL_REVIEW_EFFORT_PREFIX}${payload.estimatedEffort}/5`;
    if (!currentLabels.includes(effortLabel)) return false;
  }
  if (opts.security) {
    const wantsSecurity = payload.securityConcerns != null;
    if (currentLabels.includes(LABEL_SECURITY_CONCERN) !== wantsSecurity) return false;
  }
  return true;
}

export function reviewLabelsFromPayload(
  payload: ReviewPayload,
  opts: { effort: boolean; security: boolean },
): string[] {
  const labels: string[] = [];
  if (opts.effort) {
    labels.push(`${LABEL_REVIEW_EFFORT_PREFIX}${payload.estimatedEffort}/5`);
  }
  if (opts.security && payload.securityConcerns != null) {
    labels.push(LABEL_SECURITY_CONCERN);
  }
  return labels;
}

export function syncReviewLabels(currentLabels: string[], nextManaged: string[]): string[] {
  const preserved = currentLabels.filter(
    (name) => !name.startsWith(LABEL_REVIEW_EFFORT_PREFIX) && name !== LABEL_SECURITY_CONCERN,
  );
  return [...preserved, ...nextManaged];
}
