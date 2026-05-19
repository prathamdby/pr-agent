import crypto from "node:crypto";
import { Context, Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { parseAskQuestion, ASK_USAGE_HINT } from "../commands/parseAskQuestion.js";
import { slashHelpBody } from "../commands/slashCommandFlow.js";
import { parseSlashCommand } from "../commands/parseSlashCommand.js";
import type { ReplyTarget } from "../commands/slashCommandFlow.js";
import { inTransaction, pgBossDb } from "../db/postgres.js";
import type { CodeAnchor } from "../agent/askRun.js";
import type { ReviewMode } from "../agent/reviewSchema.js";
import { log } from "../log.js";
import {
	ACK_QUEUE,
	ASK_QUEUE,
	DEFERRED_HEAD_SHA,
	REVIEW_QUEUE,
	installationGroupId,
	prResourceKey,
	reviewSingletonKey,
	type AckJobData,
	type AckTarget,
	type AskJobData,
	type PrRef,
	type ReviewJobData,
	type WebhookHeaders,
} from "./types.js";

const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
/**
 * Automated PR webhook reviews only. Superseding/cancel_requested_at applies to
 * auto-sourced items with this lens only; slash /review-security and /ask lanes
 * are intentionally not preempted (ADR 0009 §7).
 */
const AUTOMATED_REVIEW_LENS: ReviewMode = "review";
const MAX_STORED_COMMENT_TEXT_LEN = 16_384;

function clampStoredCommentText(text: string): string {
	return text.replace(/\0/g, "").slice(0, MAX_STORED_COMMENT_TEXT_LEN);
}

type EventRecord = {
	readonly id: string;
	readonly duplicate: boolean;
};

type SlashCommandInput = {
	readonly headers: WebhookHeaders;
	readonly installationId: number;
	readonly owner: string;
	readonly repo: string;
	readonly prNumber: number;
	readonly commentId: number;
	readonly commenterId: number;
	readonly body: string;
	readonly replyTarget: ReplyTarget;
	readonly codeAnchor?: CodeAnchor;
};

export class AgentWorkScheduler extends Context.Tag("AgentWorkScheduler")<
	AgentWorkScheduler,
	{
		readonly recordIgnored: (headers: WebhookHeaders, decision: string) => Effect.Effect<void, Error>;
		readonly submitAutomatedReview: (
			headers: WebhookHeaders,
			ref: PrRef,
			action: string,
		) => Effect.Effect<void, Error>;
		readonly submitSlashCommand: (input: SlashCommandInput) => Effect.Effect<void, Error>;
	}
>() {}

function bodySha(rawBody: Buffer): string {
	return crypto.createHash("sha256").update(rawBody).digest("hex");
}

function dedupeKey(headers: WebhookHeaders): string {
	return headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha(headers.rawBody)}`;
}

async function insertWebhookEvent(
	client: PoolClient,
	headers: WebhookHeaders,
	decision: string,
): Promise<EventRecord> {
	const id = crypto.randomUUID();
	const result = await client.query<{ id: string }>(
		`INSERT INTO webhook_events (id, dedupe_key, delivery_id, event_name, body_sha256, processing_decision, processed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (dedupe_key) DO NOTHING
		 RETURNING id`,
		[id, dedupeKey(headers), headers.delivery ?? null, headers.event ?? "", bodySha(headers.rawBody), decision],
	);
	const inserted = result.rows[0]?.id;
	return inserted ? { id: inserted, duplicate: false } : { id: "", duplicate: true };
}

async function requireBossJobSend(
	boss: PgBoss,
	queue: string,
	data: object,
	options: Parameters<PgBoss["send"]>[2],
): Promise<void> {
	const jobId = await boss.send(queue, data, options);
	if (jobId == null) {
		throw new Error(`pg-boss did not enqueue ${queue} job`);
	}
}

async function enqueueAck(
	boss: PgBoss,
	client: PoolClient,
	data: AckJobData,
	priority = 100,
): Promise<void> {
	await requireBossJobSend(boss, ACK_QUEUE, data, {
		db: pgBossDb(client),
		priority,
		group: { id: installationGroupId(data.installationId) },
	});
}

async function releaseReviewSingletonSlot(
	boss: PgBoss,
	client: PoolClient,
	resourceKey: string,
	lens: ReviewMode,
): Promise<void> {
	const db = pgBossDb(client);
	const key = reviewSingletonKey(resourceKey, lens);
	const jobs = await boss.findJobs(REVIEW_QUEUE, { key, db });
	for (const job of jobs) {
		const state = job.state as string;
		if (state === "cancelled" || state === "completed" || state === "failed") continue;
		await boss.cancel(REVIEW_QUEUE, job.id, { db });
	}
}

async function enqueueReview(
	boss: PgBoss,
	client: PoolClient,
	ref: PrRef,
	workItemId: string,
	lens: ReviewMode,
): Promise<void> {
	const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
	const data: ReviewJobData = { kind: "review", workItemId };
	await requireBossJobSend(boss, REVIEW_QUEUE, data, {
		db: pgBossDb(client),
		singletonKey: reviewSingletonKey(resourceKey, lens),
		group: { id: installationGroupId(ref.installationId) },
	});
}

async function enqueueAsk(boss: PgBoss, client: PoolClient, ref: PrRef, workItemId: string): Promise<void> {
	const data: AskJobData = { kind: "ask", workItemId };
	await requireBossJobSend(boss, ASK_QUEUE, data, {
		db: pgBossDb(client),
		priority: 50,
		group: { id: installationGroupId(ref.installationId) },
	});
}

async function createReviewWorkItem(
	client: PoolClient,
	params: {
		webhookEventId: string;
		ref: PrRef;
		source: "auto" | "slash";
		lens: ReviewMode;
		priority?: number;
		userSupplement?: string;
		commenterId?: number;
	},
): Promise<string> {
	const id = crypto.randomUUID();
	const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
	await client.query(
		`INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, review_lens, resource_key, priority, payload
		 )
		 VALUES ($1, $2, 'review', $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
		[
			id,
			params.webhookEventId,
			params.source,
			params.ref.owner,
			params.ref.repo,
			params.ref.prNumber,
			params.ref.installationId,
			params.ref.headSha,
			params.lens,
			resourceKey,
			params.priority ?? 0,
			JSON.stringify({
				mode: params.lens,
				source: params.source,
				userSupplement: params.userSupplement,
				commenterId: params.commenterId,
			}),
		],
	);
	await client.query(
		`INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status)
		 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending')
		 ON CONFLICT (resource_key, review_lens, step)
		 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
		               status = 'pending',
		               updated_at = now()`,
		[crypto.randomUUID(), id, resourceKey, params.lens],
	);
	return id;
}

async function createAskWorkItem(
	client: PoolClient,
	params: {
		webhookEventId: string;
		ref: PrRef;
		question: string;
		replyTarget: ReplyTarget;
		commentId: number;
		commenterId: number;
		codeAnchor?: CodeAnchor;
	},
): Promise<string> {
	const id = crypto.randomUUID();
	await client.query(
		`INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, resource_key, priority, payload
		 )
		 VALUES ($1, $2, 'ask', 'slash', 'queued', $3, $4, $5, $6, $7, $8, 50, $9::jsonb)`,
		[
			id,
			params.webhookEventId,
			params.ref.owner,
			params.ref.repo,
			params.ref.prNumber,
			params.ref.installationId,
			params.ref.headSha,
			prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber),
			JSON.stringify({
				question: params.question,
				replyTarget: params.replyTarget,
				commentId: params.commentId,
				commenterId: params.commenterId,
				codeAnchor: params.codeAnchor,
			}),
		],
	);
	return id;
}

async function fetchActiveSameLens(client: PoolClient, resourceKey: string, lens: ReviewMode): Promise<string | null> {
	const result = await client.query<{ id: string }>(
		`SELECT id
		   FROM agent_work_items
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND status IN ('queued', 'running')
		  LIMIT 1`,
		[resourceKey, lens],
	);
	return result.rows[0]?.id ?? null;
}

export function makeAgentWorkScheduler(pool: Pool, boss: PgBoss) {
	return AgentWorkScheduler.of({
		recordIgnored: (headers, decision) =>
			Effect.tryPromise({
				try: () =>
					inTransaction(pool, async (client) => {
						const event = await insertWebhookEvent(client, headers, decision);
						if (event.duplicate) log.info("deduped_delivery", { dedupeKey: dedupeKey(headers), event: headers.event });
					}),
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			}),

		submitAutomatedReview: (headers, ref, action) =>
			Effect.tryPromise({
				try: () =>
					inTransaction(pool, async (client) => {
						if (!AUTOMATED_PR_ACTIONS.has(action)) {
							await insertWebhookEvent(client, headers, `ignored_pull_request_${action}`);
							return;
						}

						const event = await insertWebhookEvent(client, headers, "automated_review_enqueued");
						if (event.duplicate) {
							log.info("deduped_delivery", { dedupeKey: dedupeKey(headers), event: headers.event });
							return;
						}

						const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
						const olderQueued = await client.query<{ id: string }>(
							`UPDATE agent_work_items
							    SET status = 'superseded',
							        updated_at = now()
							  WHERE resource_key = $1
							    AND review_lens = $2
							    AND source = 'auto'
							    AND status = 'queued'
							  RETURNING id`,
							[resourceKey, AUTOMATED_REVIEW_LENS],
						);
						const running = await client.query<{ id: string }>(
							`UPDATE agent_work_items
							    SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
							        updated_at = now()
							  WHERE resource_key = $1
							    AND review_lens = $2
							    AND source = 'auto'
							    AND status = 'running'
							  RETURNING id`,
							[resourceKey, AUTOMATED_REVIEW_LENS],
						);

						const workItemId = await createReviewWorkItem(client, {
							webhookEventId: event.id,
							ref,
							source: "auto",
							lens: AUTOMATED_REVIEW_LENS,
						});
						await client.query(
							`UPDATE agent_work_items
							    SET superseded_by = $1
							  WHERE id = ANY($2::uuid[])`,
							[workItemId, [...olderQueued.rows, ...running.rows].map((r) => r.id)],
						);
						if (olderQueued.rows.length > 0 || running.rows.length > 0) {
							await releaseReviewSingletonSlot(boss, client, resourceKey, AUTOMATED_REVIEW_LENS);
						}
						await enqueueAck(boss, client, {
							kind: "ack",
							workItemId,
							installationId: ref.installationId,
							owner: ref.owner,
							repo: ref.repo,
							prNumber: ref.prNumber,
							targets: [{ kind: "pr", prNumber: ref.prNumber }],
							progress: { lens: AUTOMATED_REVIEW_LENS, headSha: ref.headSha, source: "auto" },
						});
						await enqueueReview(boss, client, ref, workItemId, AUTOMATED_REVIEW_LENS);
						log.info("agent_work_enqueued", { type: "review", source: "auto", workItemId, resourceKey });
					}),
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			}),

		submitSlashCommand: (input) =>
			Effect.tryPromise({
				try: () =>
					inTransaction(pool, async (client) => {
						const command = parseSlashCommand(input.body);
						if (!command) {
							await insertWebhookEvent(client, input.headers, "ignored_no_slash_command");
							return;
						}

						const event = await insertWebhookEvent(client, input.headers, `slash_${command}`);
						if (event.duplicate) {
							log.info("deduped_delivery", { dedupeKey: dedupeKey(input.headers), event: input.headers.event });
							return;
						}

						const ref: PrRef = {
							owner: input.owner,
							repo: input.repo,
							prNumber: input.prNumber,
							installationId: input.installationId,
							headSha: DEFERRED_HEAD_SHA,
						};
						const targets: AckTarget[] = [
							{ kind: "pr", prNumber: input.prNumber },
							input.replyTarget.kind === "prConversation"
								? { kind: "issueComment", commentId: input.commentId }
								: { kind: "reviewComment", commentId: input.commentId },
						];
						const baseAck = {
							kind: "ack" as const,
							installationId: input.installationId,
							owner: input.owner,
							repo: input.repo,
							prNumber: input.prNumber,
							targets,
							commenterId: input.commenterId,
						};

						if (command === "help") {
							await enqueueAck(boss, client, { ...baseAck, reply: { target: input.replyTarget, body: slashHelpBody } });
							return;
						}

						if (command === "ask") {
							const question = parseAskQuestion(input.body);
							if (!question) {
								await enqueueAck(boss, client, {
									...baseAck,
									reply: { target: input.replyTarget, body: ASK_USAGE_HINT },
								});
								return;
							}
							const headSha = DEFERRED_HEAD_SHA;
							const askRef = { ...ref, headSha };
							const workItemId = await createAskWorkItem(client, {
								webhookEventId: event.id,
								ref: askRef,
								question,
								replyTarget: input.replyTarget,
								commentId: input.commentId,
								commenterId: input.commenterId,
								codeAnchor: input.codeAnchor,
							});
							await enqueueAck(boss, client, { ...baseAck, workItemId });
							await enqueueAsk(boss, client, ref, workItemId);
							log.info("agent_work_enqueued", { type: "ask", source: "slash", workItemId });
							return;
						}

						if (command === "review" || command === "review-security") {
							const lens = command as ReviewMode;
							const resourceKey = prResourceKey(input.owner, input.repo, input.prNumber);
							const existing = await fetchActiveSameLens(client, resourceKey, lens);
							if (existing) {
								await enqueueAck(boss, client, {
									...baseAck,
									reply: {
										target: input.replyTarget,
										body: `A \`/${command}\` run is already queued or in progress for this pull request.`,
									},
								});
								return;
							}

							const workItemId = await createReviewWorkItem(client, {
								webhookEventId: event.id,
								ref,
								source: "slash",
								lens,
								userSupplement: clampStoredCommentText(
									`User invoked /${command} with:\n${input.body}`,
								),
								commenterId: input.commenterId,
							});
							await enqueueAck(boss, client, {
								...baseAck,
								workItemId,
								progress: { lens, headSha: ref.headSha, source: "slash" },
							});
							await enqueueReview(boss, client, ref, workItemId, lens);
							log.info("agent_work_enqueued", { type: "review", source: "slash", workItemId, resourceKey, lens });
							return;
						}

						await enqueueAck(boss, client, {
							...baseAck,
							reply: { target: input.replyTarget, body: `Unknown command \`/${command}\`. Try \`/help\`.` },
						});
					}),
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			}),
	});
}

