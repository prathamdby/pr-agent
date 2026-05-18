import type { ReviewRunResult } from "./reviewRun.js";
import { log } from "../log.js";

export function logReviewRunOutcome(
	result: ReviewRunResult,
	ctx: { owner: string; repo: string; prNumber: number },
): void {
	if (!result.published) {
		log.warn("review_not_published", {
			owner: ctx.owner,
			repo: ctx.repo,
			pr: ctx.prNumber,
		});
	}
}
