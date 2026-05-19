import type { Config } from "../config.js";
import {
	createPullRequestReviewWithComments,
	listPullRequestLabels,
	setPullRequestLabels,
	upsertReviewSummaryComment,
	type InlineReviewComment,
} from "../github/reviewPublish.js";
import { labelsAlreadySynced, reviewLabelsFromPayload, syncReviewLabels } from "./reviewLabels.js";
import { log } from "../log.js";
import { renderInlineThreadBody, renderReviewPointerBody, renderReviewSummaryComment } from "./reviewRender.js";
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
	recordPublishStep?: (
		step: "inline_review" | "summary_comment" | "labels",
		detail?: { githubId?: string | number; meta?: Record<string, unknown> },
	) => Promise<void>;
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

		if (comments.length > 0) {
			const pointerBody = renderReviewPointerBody(payload, {
				owner,
				repo,
				prNumber,
				headSha,
				maxFindings: cfg.maxReviewFindings,
				mode,
			});
			if (pointerBody.truncated) {
				log.warn("agent_fix_prompt_truncated", {
					mode,
					owner,
					repo,
					pr: prNumber,
				});
			}
			const review = await createPullRequestReviewWithComments(token, owner, repo, prNumber, {
				body: pointerBody.body,
				event,
				comments,
			});
			await params.recordPublishStep?.("inline_review", {
				githubId: review.id,
				meta: {
					url: review.url,
					inlineCount: comments.length,
					event,
					agentFixPromptTruncated: pointerBody.truncated,
				},
			});

			log.info("review_published_inline", {
				mode,
				owner,
				repo,
				pr: prNumber,
				reviewId: review.id,
				event,
				inlineCount: comments.length,
			});
		} else {
			log.info("review_inline_skipped", {
				reason: "no_p0_p2_findings",
				mode,
				owner,
				repo,
				pr: prNumber,
			});
		}

		publishState.inlinePublished = true;
		if (comments.length === 0) {
			await params.recordPublishStep?.("inline_review", {
				meta: { inlineCount: 0, reason: "no_p0_p2_findings" },
			});
		}
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
	await params.recordPublishStep?.("summary_comment", {
		githubId: summary.id,
		meta: { updated: summary.updated },
	});
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
				labelsAlreadySynced(current, payload, {
					effort: cfg.enableReviewLabelsEffort,
					security: cfg.enableReviewLabelsSecurity,
				})
			) {
				await params.recordPublishStep?.("labels", { meta: { labels: current, alreadySynced: true } });
				return;
			}
			const managed = reviewLabelsFromPayload(payload, {
				effort: cfg.enableReviewLabelsEffort,
				security: cfg.enableReviewLabelsSecurity,
			});
			const next = syncReviewLabels(current, managed);
			await setPullRequestLabels(token, owner, repo, prNumber, next);
			await params.recordPublishStep?.("labels", { meta: { labels: next } });
			log.info("review_labels_synced", { owner, repo, pr: prNumber, labels: next });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.warn("review_labels_sync_failed", { owner, repo, pr: prNumber, message });
		}
	}
}
