import {
  LABEL_CATEGORY_PREFIX,
  LABEL_REVIEW_SIZE_PREFIX,
  LABEL_SECURITY_CONCERN,
} from "../../settings/index.js";
import {
  REVIEW_FINDING_CATEGORIES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewPayload,
} from "../reviewSchema.js";

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

export function hasManagedCategoryLabel(currentLabels: readonly string[]): boolean {
  return currentLabels.some((label) => label.startsWith(LABEL_CATEGORY_PREFIX));
}

export function reviewSizeLabel(payload: ReviewPayload): string {
  return `${LABEL_REVIEW_SIZE_PREFIX}${payload.size}`;
}

export function labelsAlreadySynced(
  currentLabels: string[],
  payload: ReviewPayload,
  opts: { size: boolean; security: boolean; category: boolean },
): boolean {
  if (opts.size) {
    const sizeLabel = reviewSizeLabel(payload);
    const currentSizeLabels = currentLabels.filter((label) =>
      label.startsWith(LABEL_REVIEW_SIZE_PREFIX),
    );
    if (currentSizeLabels.length !== 1 || currentSizeLabels[0] !== sizeLabel) return false;
  }
  if (opts.security) {
    const wantsSecurity = payload.securityConcerns != null;
    if (currentLabels.includes(LABEL_SECURITY_CONCERN) !== wantsSecurity) return false;
  }
  if (opts.category) {
    const wantsCategory = categoryLabelForPayload(payload);
    if (currentLabels.find((label) => label.startsWith(LABEL_CATEGORY_PREFIX)) !== wantsCategory)
      return false;
  }
  return true;
}

export function reviewLabelsFromPayload(
  payload: ReviewPayload,
  opts: { size: boolean; security: boolean; category: boolean },
): string[] {
  const labels: string[] = [];
  if (opts.size) {
    labels.push(reviewSizeLabel(payload));
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

export function syncReviewLabels(currentLabels: string[], nextManaged: string[]): string[] {
  const preserved = currentLabels.filter(
    (name) =>
      !name.startsWith(LABEL_REVIEW_SIZE_PREFIX) &&
      name !== LABEL_SECURITY_CONCERN &&
      !name.startsWith(LABEL_CATEGORY_PREFIX),
  );
  return [...preserved, ...nextManaged];
}
