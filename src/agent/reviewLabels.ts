import type { ReviewPayload } from "./reviewSchema.js";

export const LABEL_REVIEW_EFFORT_PREFIX = "Review effort ";
export const LABEL_SECURITY_CONCERN = "Possible security concern";

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

/** Idempotent label sync: drop managed namespace, preserve unrelated labels, add current run's. */
export function syncReviewLabels(currentLabels: string[], nextManaged: string[]): string[] {
	const preserved = currentLabels.filter(
		(name) => !name.startsWith(LABEL_REVIEW_EFFORT_PREFIX) && name !== LABEL_SECURITY_CONCERN,
	);
	return [...preserved, ...nextManaged];
}
