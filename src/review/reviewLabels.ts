import {
  LABEL_QUALITY_EFFORT_PREFIX,
  LABEL_REVIEW_EFFORT_PREFIX,
  LABEL_SECURITY_CONCERN,
  LABEL_SECURITY_EFFORT_PREFIX,
} from "../settings/index.js";
import type { ReviewMode, ReviewPayload } from "./reviewSchema.js";

function reviewEffortLabelPrefix(mode: ReviewMode): string {
  switch (mode) {
    case "review-security":
      return LABEL_SECURITY_EFFORT_PREFIX;
    case "review-quality":
      return LABEL_QUALITY_EFFORT_PREFIX;
    case "review":
      return LABEL_REVIEW_EFFORT_PREFIX;
  }
  const exhaustive: never = mode;
  return exhaustive;
}

export function labelsAlreadySynced(
  currentLabels: string[],
  payload: ReviewPayload,
  opts: { effort: boolean; security: boolean },
  mode: ReviewMode = "review",
): boolean {
  if (opts.effort) {
    const effortPrefix = reviewEffortLabelPrefix(mode);
    const effortLabel = `${effortPrefix}${payload.estimatedEffort}/5`;
    const currentEffortLabels = currentLabels.filter((label) => label.startsWith(effortPrefix));
    if (currentEffortLabels.length !== 1 || currentEffortLabels[0] !== effortLabel) return false;
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
  mode: ReviewMode = "review",
): string[] {
  const labels: string[] = [];
  if (opts.effort) {
    labels.push(`${reviewEffortLabelPrefix(mode)}${payload.estimatedEffort}/5`);
  }
  if (opts.security && payload.securityConcerns != null) {
    labels.push(LABEL_SECURITY_CONCERN);
  }
  return labels;
}

export function syncReviewLabels(
  currentLabels: string[],
  nextManaged: string[],
  mode: ReviewMode = "review",
): string[] {
  const effortPrefix = reviewEffortLabelPrefix(mode);
  const preserved = currentLabels.filter(
    (name) => !name.startsWith(effortPrefix) && name !== LABEL_SECURITY_CONCERN,
  );
  return [...preserved, ...nextManaged];
}
