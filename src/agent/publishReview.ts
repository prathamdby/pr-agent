import type { Config } from "../config.js";
import {
	createPullRequestReviewWithComments,
	listPullRequestLabels,
	setPullRequestLabels,
	upsertReviewSummaryComment,
	type InlineReviewComment,
} from "../github/reviewPublish.js";
import { log } from "../log.js";
import { LABEL_REVIEW_EFFORT_PREFIX, reviewLabelsFromPayload, syncReviewLabels } from "./reviewLabels.js";
import { renderInlineThreadBody, renderReviewSummaryComment, reviewPointerBodyForMode } from "./reviewRender.js";
import {
	normalizeReviewPayload,
	reviewEventForFindings,
	reviewSummarySentinelForMode,
	selectInlineFindings,
	type ReviewMode,
	type ReviewPayload,
	type ReviewPublishContext,
} from "./reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";

export async function publishReview(params: ReviewPublishContext & {
	token: string;
	mode?: ReviewMode;
	cfg: Pick<Config, "maxReviewFindings" | "enableReviewLabelsEffort" | "enableReviewLabelsSecurity">;
	payload: ReviewPayload;
	publishState: SubmitReviewState;
}): Promise<void> {
	const { token, owner, repo, prNumber, headSha, cfg, payload: raw, publishState } = params;
	const mode = params.mode ?? "review";
	const summarySentinel = reviewSummarySentinelForMode(mode);
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
			body: reviewPointerBodyForMode(mode),
			event,
			comments: comments.length > 0 ? comments : undefined,
		});

		publishState.inlinePublished = true;
		log.info("review_published_inline", {
			mode,
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
		summarySentinel,
	});

	const summary = await upsertReviewSummaryComment(token, owner, repo, prNumber, summaryBody, summarySentinel);
	log.info("review_published_summary", {
		mode,
		owner,
		repo,
		pr: prNumber,
		commentId: summary.id,
		updated: summary.updated,
	});

	if (cfg.enableReviewLabelsEffort || cfg.enableReviewLabelsSecurity) {
		try {
			const current = await listPullRequestLabels(token, owner, repo, prNumber);
			if (
				cfg.enableReviewLabelsEffort &&
				current.includes(`${LABEL_REVIEW_EFFORT_PREFIX}${payload.estimatedEffort}/5`)
			) {
				return;
			}
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
