import {
  LABEL_CATEGORY_PREFIX,
  LABEL_REVIEW_EFFORT_PREFIX,
  LABEL_SECURITY_CONCERN,
} from "../../settings/index.js";
import {
  REVIEW_FINDING_CATEGORIES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewPayload,
} from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

export function dominantReviewCategory(
  findings: readonly ReviewFinding[],
): ReviewFindingCategory | undefined {
  const counts = new Map<ReviewFindingCategory, number>();
  for (const finding of findings) {
    if (finding.category == null) continue;
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }
  let best: ReviewFindingCategory | undefined;
  let bestCount = 0;
  for (const category of REVIEW_FINDING_CATEGORIES) {
    const count = counts.get(category) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = category;
    }
  }
  return bestCount > 0 ? best : undefined;
}

function categoryLabelForPayload(payload: ReviewPayload): string | undefined {
  const category = dominantReviewCategory(payload.findings);
  return category == null ? undefined : `${LABEL_CATEGORY_PREFIX}${category}`;
}

function currentCategoryLabel(currentLabels: readonly string[]): string | undefined {
  return currentLabels.find((label) => label.startsWith(LABEL_CATEGORY_PREFIX));
}

export function hasManagedCategoryLabel(currentLabels: readonly string[]): boolean {
  return currentLabels.some((label) => label.startsWith(LABEL_CATEGORY_PREFIX));
}

export function labelsAlreadySynced(
  currentLabels: string[],
  payload: ReviewPayload,
  opts: { effort: boolean; security: boolean; category: boolean },
  _mode: AnyReviewLens = "review",
): boolean {
  if (opts.effort) {
    const effortPrefix = LABEL_REVIEW_EFFORT_PREFIX;
    const effortLabel = `${effortPrefix}${payload.estimatedEffort}/5`;
    const currentEffortLabels = currentLabels.filter((label) => label.startsWith(effortPrefix));
    if (currentEffortLabels.length !== 1 || currentEffortLabels[0] !== effortLabel) return false;
  }
  if (opts.security) {
    const wantsSecurity = payload.securityConcerns != null;
    if (currentLabels.includes(LABEL_SECURITY_CONCERN) !== wantsSecurity) return false;
  }
  if (opts.category) {
    const wantsCategory = categoryLabelForPayload(payload);
    if (currentCategoryLabel(currentLabels) !== wantsCategory) return false;
  }
  return true;
}

export function reviewLabelsFromPayload(
  payload: ReviewPayload,
  opts: { effort: boolean; security: boolean; category: boolean },
  _mode: AnyReviewLens = "review",
): string[] {
  const labels: string[] = [];
  if (opts.effort) {
    labels.push(`${LABEL_REVIEW_EFFORT_PREFIX}${payload.estimatedEffort}/5`);
  }
  if (opts.security && payload.securityConcerns != null) {
    labels.push(LABEL_SECURITY_CONCERN);
  }
  if (opts.category) {
    const categoryLabel = categoryLabelForPayload(payload);
    if (categoryLabel != null) labels.push(categoryLabel);
  }
  return labels;
}

export function syncReviewLabels(
  currentLabels: string[],
  nextManaged: string[],
  _mode: AnyReviewLens = "review",
): string[] {
  const preserved = currentLabels.filter(
    (name) =>
      !name.startsWith(LABEL_REVIEW_EFFORT_PREFIX) &&
      name !== LABEL_SECURITY_CONCERN &&
      !name.startsWith(LABEL_CATEGORY_PREFIX),
  );
  return [...preserved, ...nextManaged];
}
