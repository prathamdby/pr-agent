import type { Config } from "../config.js";
import {
	createPullRequestReviewWithComments,
	listPullRequestLabels,
	setPullRequestLabels,
	upsertReviewSummaryComment,
	type InlineReviewComment,
} from "../github/reviewPublish.js";
import { log } from "../log.js";
import { reviewLabelsFromPayload, syncReviewLabels } from "./reviewLabels.js";
import { REVIEW_POINTER_BODY, renderInlineThreadBody, renderReviewSummaryComment } from "./reviewRender.js";
import {
	normalizeReviewPayload,
	reviewEventForFindings,
	selectInlineFindings,
	type ReviewPayload,
	type ReviewPublishContext,
} from "./reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";

export async function publishReview(params: ReviewPublishContext & {
	token: string;
	cfg: Pick<Config, "maxReviewFindings" | "enableReviewLabelsEffort" | "enableReviewLabelsSecurity">;
	payload: ReviewPayload;
	publishState: SubmitReviewState;
}): Promise<void> {
	const { token, owner, repo, prNumber, headSha, cfg, payload: raw, publishState } = params;
	const payload = normalizeReviewPayload(raw);
	const inlineFindings = selectInlineFindings(payload.findings, cfg.maxReviewFindings);
	const event = reviewEventForFindings(payload.findings);

	if (!publishState.inlinePublished) {
		const comments: InlineReviewComment[] = inlineFindings.map((f) => ({
			path: f.file,
			line: f.startLine,
			side: "RIGHT" as const,
			body: renderInlineThreadBody(f),
		}));

		const review = await createPullRequestReviewWithComments(token, owner, repo, prNumber, {
			body: REVIEW_POINTER_BODY,
			event,
			comments: comments.length > 0 ? comments : undefined,
		});

		publishState.inlinePublished = true;
		log.info("review_published_inline", {
			owner,
			repo,
			pr: prNumber,
			reviewId: review.id,
			event,
			inlineCount: comments.length,
		});
	}

	const summaryBody = renderReviewSummaryComment(payload, {
		owner,
		repo,
		prNumber,
		headSha,
		maxFindings: cfg.maxReviewFindings,
	});

	const summary = await upsertReviewSummaryComment(token, owner, repo, prNumber, summaryBody);
	log.info("review_published_summary", {
		owner,
		repo,
		pr: prNumber,
		commentId: summary.id,
		updated: summary.updated,
	});

	if (cfg.enableReviewLabelsEffort || cfg.enableReviewLabelsSecurity) {
		try {
			const current = await listPullRequestLabels(token, owner, repo, prNumber);
			const managed = reviewLabelsFromPayload(payload, {
				effort: cfg.enableReviewLabelsEffort,
				security: cfg.enableReviewLabelsSecurity,
			});
			const next = syncReviewLabels(current, managed);
			await setPullRequestLabels(token, owner, repo, prNumber, next);
			log.info("review_labels_synced", { owner, repo, pr: prNumber, labels: next });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.warn("review_labels_sync_failed", { owner, repo, pr: prNumber, message });
		}
	}
}
