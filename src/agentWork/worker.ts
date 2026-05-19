import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { runAskRun } from "../agent/askRun.js";
import { formatAskFailureReply } from "../agent/formatAskReply.js";
import { runFullPrReview } from "../agent/reviewRun.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../agent/reviewSchema.js";
import { installationOctokit, mintBotIdentity, mintInstallationAuth } from "../github/appAuth.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { log } from "../log.js";
import {
	getReviewPublishState,
	getWorkItem,
	markWorkCancelled,
	markWorkCompleted,
	markWorkFailed,
	markWorkRetrying,
	markWorkRunning,
	recordPublishStep,
	shouldSkipWork,
} from "./repository.js";
import { renderReviewFailureNotice, renderReviewProgressComment } from "./progressComment.js";
import {
	ACK_QUEUE,
	ASK_QUEUE,
	REVIEW_QUEUE,
	type AckJobData,
	type AckTarget,
	type AgentWorkItem,
	type AskWorkPayload,
	type AskJobData,
	type ReviewJobData,
	type ReviewWorkPayload,
} from "./types.js";

function isTerminalPgBossAttempt(job: JobWithMetadata<ReviewJobData | AskJobData>): boolean {
	return job.retryCount >= job.retryLimit;
}

async function getInstallationToken(cfg: Config, installationId: number) {
	const auth = await mintInstallationAuth(cfg, installationId);
	const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
	const now = Date.now();
	const expiresAtTs = Number.isFinite(parsed) ? parsed : now + 55 * 60 * 1000;
	return { token: auth.token, expiresAtTs, ttlMs: Math.max(0, expiresAtTs - now) };
}

async function isBotCommenter(cfg: Config, token: string, commenterId?: number): Promise<boolean> {
	if (commenterId == null) return false;
	const bot = await mintBotIdentity(cfg, token);
	return bot.userId === commenterId;
}

async function getPullRequestHeadSha(token: string, owner: string, repo: string, prNumber: number): Promise<string> {
	const octokit = installationOctokit(token);
	const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
	return data.head.sha;
}

async function safeReaction(
	token: string,
	owner: string,
	repo: string,
	target: AckTarget,
): Promise<void> {
	const octokit = installationOctokit(token);
	try {
		if (target.kind === "pr") {
			await octokit.rest.reactions.createForIssue({
				owner,
				repo,
				issue_number: target.prNumber,
				content: "eyes",
			});
		} else if (target.kind === "issueComment") {
			await octokit.rest.reactions.createForIssueComment({
				owner,
				repo,
				comment_id: target.commentId,
				content: "eyes",
			});
		} else {
			await octokit.rest.reactions.createForPullRequestReviewComment({
				owner,
				repo,
				comment_id: target.commentId,
				content: "eyes",
			});
		}
	} catch (e: unknown) {
		const status = (e as { status?: number }).status;
		if (status === 422 || status === 403) return;
		throw e;
	}
}

async function postReply(token: string, data: AckJobData, body: string): Promise<void> {
	const target = data.reply?.target;
	if (!target) return;
	const octokit = installationOctokit(token);
	if (target.kind === "inlineReviewThread") {
		await octokit.rest.pulls.createReplyForReviewComment({
			owner: data.owner,
			repo: data.repo,
			pull_number: target.prNumber,
			comment_id: target.inReplyToCommentId,
			body,
		});
		return;
	}
	await octokit.rest.issues.createComment({
		owner: data.owner,
		repo: data.repo,
		issue_number: target.prNumber,
		body,
	});
}

async function handleAckJob(cfg: Config, pool: Pool, data: AckJobData): Promise<void> {
	const installation = await getInstallationToken(cfg, data.installationId);
	if (await isBotCommenter(cfg, installation.token, data.commenterId)) return;

	for (const target of data.targets) {
		await safeReaction(installation.token, data.owner, data.repo, target);
	}

	if (data.progress) {
		const headSha =
			data.progress.headSha === "deferred-to-worker"
				? await getPullRequestHeadSha(installation.token, data.owner, data.repo, data.prNumber)
				: data.progress.headSha;
		const body = renderReviewProgressComment({
			mode: data.progress.lens,
			headSha,
			source: data.progress.source,
		});
		const summary = await upsertReviewSummaryComment(
			installation.token,
			data.owner,
			data.repo,
			data.prNumber,
			body,
			reviewSummarySentinelForMode(data.progress.lens),
		);
		if (data.workItemId) {
			await recordPublishStep(pool, {
				workItemId: data.workItemId,
				resourceKey: `${data.owner}/${data.repo}#${data.prNumber}`,
				reviewLens: data.progress.lens,
				step: "progress_comment",
				githubId: summary.id,
				detail: { updated: summary.updated },
			});
		}
	}

	if (data.reply) {
		await postReply(installation.token, data, data.reply.body);
	}
}

async function maybeSkipBotWork(cfg: Config, token: string, item: AgentWorkItem): Promise<boolean> {
	const commenterId = (item.payload as { commenterId?: number }).commenterId;
	return isBotCommenter(cfg, token, commenterId);
}

async function handleReviewJob(
	cfg: Config,
	pool: Pool,
	job: JobWithMetadata<ReviewJobData>,
): Promise<void> {
	const data = job.data;
	const item = await getWorkItem(pool, data.workItemId);
	if (!item || item.type !== "review" || !item.reviewLens) return;
	if (await shouldSkipWork(pool, item)) {
		await markWorkCancelled(pool, item.id);
		return;
	}
	if (!(await markWorkRunning(pool, item.id))) return;

	const installation = await getInstallationToken(cfg, item.installationId);
	const payload = item.payload as ReviewWorkPayload;
	if (await maybeSkipBotWork(cfg, installation.token, item)) {
		await markWorkCancelled(pool, item.id);
		return;
	}

	const headSha =
		item.headSha === "deferred-to-worker"
			? await getPullRequestHeadSha(installation.token, item.owner, item.repo, item.prNumber)
			: item.headSha;
	await pool.query("UPDATE agent_work_items SET head_sha = $2, updated_at = now() WHERE id = $1", [
		item.id,
		headSha,
	]);

	const publishState = await getReviewPublishState(pool, item.resourceKey, item.reviewLens);
	try {
		log.info("agent_work_started", { type: "review", workItemId: item.id, resourceKey: item.resourceKey });
		const result = await runFullPrReview({
			cfg,
			token: installation.token,
			tokenExpiresAtTs: installation.expiresAtTs,
			tokenTtlMs: installation.ttlMs,
			owner: item.owner,
			repo: item.repo,
			prNumber: item.prNumber,
			headSha,
			mode: item.reviewLens,
			userSupplement: payload.userSupplement,
			initialPublishState: {
				inlinePublished: publishState.inlinePublished,
				published: publishState.summaryPublished,
			},
			recordPublishStep: (step, detail) =>
				recordPublishStep(pool, {
					workItemId: item.id,
					resourceKey: item.resourceKey,
					reviewLens: item.reviewLens as ReviewMode,
					step,
					githubId: detail?.githubId,
					detail: detail?.meta,
				}),
		});
		if (await shouldSkipWork(pool, item)) {
			await markWorkCancelled(pool, item.id);
			return;
		}
		if (!result.published) {
			log.warn("review_not_published", {
				owner: item.owner,
				repo: item.repo,
				pr: item.prNumber,
				publishAttempts: result.publishAttempts,
			});
		}
		await markWorkCompleted(pool, item.id);
		log.info("agent_work_completed", { type: "review", workItemId: item.id });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (!isTerminalPgBossAttempt(job)) {
			await markWorkRetrying(pool, item.id, e);
			log.warn("agent_work_retrying", { type: "review", workItemId: item.id, message });
			throw e;
		}
		await markWorkFailed(pool, item.id, e);
		const body = renderReviewFailureNotice({
			mode: item.reviewLens,
			retryCommand: item.reviewLens === "review-security" ? "/review-security" : "/review",
		});
		try {
			await upsertReviewSummaryComment(
				installation.token,
				item.owner,
				item.repo,
				item.prNumber,
				body,
				reviewSummarySentinelForMode(item.reviewLens),
			);
		} catch (publishError) {
			log.warn("review_failure_notice_failed", {
				workItemId: item.id,
				message: publishError instanceof Error ? publishError.message : String(publishError),
			});
		}
		log.error("agent_work_failed", { type: "review", workItemId: item.id, message });
		throw e;
	}
}

async function publishAskAnswer(token: string, item: AgentWorkItem, answer: string): Promise<void> {
	const replyTarget = (item.payload as AskWorkPayload).replyTarget;
	const octokit = installationOctokit(token);
	if (replyTarget.kind === "inlineReviewThread") {
		try {
			await octokit.rest.pulls.createReplyForReviewComment({
				owner: item.owner,
				repo: item.repo,
				pull_number: replyTarget.prNumber,
				comment_id: replyTarget.inReplyToCommentId,
				body: answer,
			});
			return;
		} catch (e) {
			log.warn("ask_inline_reply_failed", {
				owner: item.owner,
				repo: item.repo,
				pr: replyTarget.prNumber,
				inReplyToCommentId: replyTarget.inReplyToCommentId,
				message: e instanceof Error ? e.message : String(e),
			});
			await octokit.rest.issues.createComment({
				owner: item.owner,
				repo: item.repo,
				issue_number: replyTarget.prNumber,
				body: ["_Could not reply in the review thread; posting here instead._", "", answer].join("\n"),
			});
			return;
		}
	}
	await octokit.rest.issues.createComment({
		owner: item.owner,
		repo: item.repo,
		issue_number: replyTarget.prNumber,
		body: answer,
	});
}

async function handleAskJob(cfg: Config, pool: Pool, job: JobWithMetadata<AskJobData>): Promise<void> {
	const data = job.data;
	const item = await getWorkItem(pool, data.workItemId);
	if (!item || item.type !== "ask") return;
	if (!(await markWorkRunning(pool, item.id))) return;

	const installation = await getInstallationToken(cfg, item.installationId);
	if (await maybeSkipBotWork(cfg, installation.token, item)) {
		await markWorkCancelled(pool, item.id);
		return;
	}
	const payload = item.payload as AskWorkPayload;
	const headSha = await getPullRequestHeadSha(installation.token, item.owner, item.repo, item.prNumber);
	try {
		log.info("agent_work_started", { type: "ask", workItemId: item.id, resourceKey: item.resourceKey });
		const result = await runAskRun({
			cfg,
			token: installation.token,
			tokenExpiresAtTs: installation.expiresAtTs,
			tokenTtlMs: installation.ttlMs,
			owner: item.owner,
			repo: item.repo,
			prNumber: item.prNumber,
			headSha,
			question: payload.question,
			replyTarget: payload.replyTarget,
			codeAnchor: payload.codeAnchor,
		});
		await publishAskAnswer(installation.token, item, result.answer);
		await markWorkCompleted(pool, item.id);
		log.info("agent_work_completed", { type: "ask", workItemId: item.id });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (!isTerminalPgBossAttempt(job)) {
			await markWorkRetrying(pool, item.id, e);
			log.warn("agent_work_retrying", { type: "ask", workItemId: item.id, message });
			throw e;
		}
		await markWorkFailed(pool, item.id, e);
		try {
			await publishAskAnswer(
				installation.token,
				item,
				formatAskFailureReply({
					question: payload.question,
					message: "PR Agent could not complete this ask after retries. Please try again later.",
					replyTarget: payload.replyTarget,
				}),
			);
		} catch (publishError) {
			log.warn("ask_failure_reply_failed", {
				workItemId: item.id,
				message: publishError instanceof Error ? publishError.message : String(publishError),
			});
		}
		log.error("agent_work_failed", { type: "ask", workItemId: item.id, message });
		throw e;
	}
}

export const AgentWorkerLive = (cfg: Config, pool: Pool, boss: PgBoss) =>
	Layer.scopedDiscard(
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					const workers = await Promise.all([
						boss.work<AckJobData>(ACK_QUEUE, { localConcurrency: cfg.ackConcurrency }, async ([job]) => {
							await handleAckJob(cfg, pool, job.data);
						}),
						boss.work<ReviewJobData>(
							REVIEW_QUEUE,
							{
								localConcurrency: cfg.reviewConcurrency,
								groupConcurrency: cfg.installationGroupConcurrency,
								heartbeatRefreshSeconds: Math.max(1, Math.floor(cfg.queueHeartbeatSeconds / 2)),
								includeMetadata: true,
							},
							async ([job]) => {
								await handleReviewJob(cfg, pool, job);
							},
						),
						boss.work<AskJobData>(
							ASK_QUEUE,
							{
								localConcurrency: cfg.askConcurrency,
								groupConcurrency: cfg.installationGroupConcurrency,
								heartbeatRefreshSeconds: Math.max(1, Math.floor(cfg.queueHeartbeatSeconds / 2)),
								includeMetadata: true,
							},
							async ([job]) => {
								await handleAskJob(cfg, pool, job);
							},
						),
					]);
					log.info("agent_worker_started", {
						queues: [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE],
						reviewConcurrency: cfg.reviewConcurrency,
						askConcurrency: cfg.askConcurrency,
						ackConcurrency: cfg.ackConcurrency,
					});
					for (const queue of [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE]) {
						const stats = await boss.getQueueStats(queue);
						log.info("agent_queue_stats", {
							queue,
							queued: stats.queuedCount,
							active: stats.activeCount,
							total: stats.totalCount,
						});
					}
					const blockedReviewKeys = await boss.getBlockedKeys(REVIEW_QUEUE);
					if (blockedReviewKeys.length > 0) {
						log.warn("agent_review_queue_blocked_keys", { keys: blockedReviewKeys });
					}
					return workers;
				},
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			}),
			() =>
				Effect.tryPromise({
					try: async () => {
						await boss.offWork(ACK_QUEUE);
						await boss.offWork(REVIEW_QUEUE);
						await boss.offWork(ASK_QUEUE);
					},
					catch: (e) => (e instanceof Error ? e : new Error(String(e))),
				}).pipe(Effect.orDie),
		).pipe(Effect.zipRight(Effect.never)),
	);

