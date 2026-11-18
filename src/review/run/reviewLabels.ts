import {
  LABEL_CATEGORY_PREFIX,
  LABEL_REVIEW_SIZE_PREFIX,
  LABEL_SECURITY_CONCERN,
  REVIEW_SIZES,
} from "../../settings/index.ts";
import {
  REVIEW_FINDING_CATEGORIES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewPayload,
} from "../reviewSchema.ts";

const LEGACY_REVIEW_EFFORT_LABEL = /^Review effort [1-5]\/5$/;

export function dominantReviewCategory(findings: readonly ReviewFinding[]) {
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
  return ((pinnedReturn: ReviewFindingCategory | undefined) => pinnedReturn)(
    bestCount > 0 ? best : undefined,
  );
}

function categoryLabelForPayload(payload: ReviewPayload) {
  const category = dominantReviewCategory(payload.findings);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    category == null ? undefined : `${LABEL_CATEGORY_PREFIX}${category}`,
  );
}

export function hasManagedCategoryLabel(currentLabels: readonly string[]) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    currentLabels.some((label) => label.startsWith(LABEL_CATEGORY_PREFIX)),
  );
}

export function reviewSizeLabel(payload: ReviewPayload) {
  return ((pinnedReturn: string) => pinnedReturn)(`${LABEL_REVIEW_SIZE_PREFIX}${payload.size}`);
}

function hasSecurityCategory(payload: ReviewPayload) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    payload.findings.some((finding) => finding.category === "security"),
  );
}

export function labelsAlreadySynced(
  currentLabels: string[],
  payload: ReviewPayload,
  opts: { size: boolean; security: boolean; category: boolean },
) {
  if (opts.size) {
    const sizeLabel = reviewSizeLabel(payload);
    const currentSizeLabels = currentLabels.filter((label) =>
      label.startsWith(LABEL_REVIEW_SIZE_PREFIX),
    );
    if (currentSizeLabels.length !== 1 || currentSizeLabels[0] !== sizeLabel)
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  if (opts.security) {
    const wantsSecurity = hasSecurityCategory(payload);
    if (currentLabels.includes(LABEL_SECURITY_CONCERN) !== wantsSecurity)
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  if (opts.category) {
    const wantsCategory = categoryLabelForPayload(payload);
    if (currentLabels.find((label) => label.startsWith(LABEL_CATEGORY_PREFIX)) !== wantsCategory)
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

export function reviewLabelsFromPayload(
  payload: ReviewPayload,
  opts: { size: boolean; security: boolean; category: boolean },
) {
  const labels: string[] = [];
  if (opts.size) {
    labels.push(reviewSizeLabel(payload));
  }
  if (opts.security && hasSecurityCategory(payload)) {
    labels.push(LABEL_SECURITY_CONCERN);
  }
  if (opts.category) {
    const categoryLabel = categoryLabelForPayload(payload);
    if (categoryLabel != null) labels.push(categoryLabel);
  }
  return ((pinnedReturn: string[]) => pinnedReturn)(labels);
}

export function syncReviewLabels(currentLabels: string[], nextManaged: string[]) {
  const preserved = currentLabels.filter(
    (name) =>
      !REVIEW_SIZES.some((size) => name === `${LABEL_REVIEW_SIZE_PREFIX}${size}`) &&
      !LEGACY_REVIEW_EFFORT_LABEL.test(name) &&
      name !== LABEL_SECURITY_CONCERN &&
      !name.startsWith(LABEL_CATEGORY_PREFIX),
  );
  return ((pinnedReturn: string[]) => pinnedReturn)([...preserved, ...nextManaged]);
}
