import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { CodeAnchor } from "../../agent/askRun.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { ReviewMode } from "../../review/reviewSchema.js";
import type { WorkSource } from "../../review/workSource.js";
import type { AutoWorkSupersedeTarget } from "../autoWorkEnqueue.js";
import { prResourceKey, type PrRef } from "../types.js";

export async function createReviewWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
    source: WorkSource;
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

export async function createDescriptionWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
    source: WorkSource;
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
		 VALUES ($1, $2, 'description', $3, 'queued', $4, $5, $6, $7, $8, NULL, $9, $10, $11::jsonb)`,
    [
      id,
      params.webhookEventId,
      params.source,
      params.ref.owner,
      params.ref.repo,
      params.ref.prNumber,
      params.ref.installationId,
      params.ref.headSha,
      resourceKey,
      params.source === "slash" ? 50 : 0,
      JSON.stringify({
        source: params.source,
        userSupplement: params.userSupplement,
        commenterId: params.commenterId,
      }),
    ],
  );
  return id;
}

export async function createAskWorkItem(
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

export async function fetchActiveWorkItem(
  client: PoolClient,
  target: AutoWorkSupersedeTarget,
): Promise<string | null> {
  if (target.kind === "description") {
    const result = await client.query<{ id: string }>(
      `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = 'description'
			    AND status IN ('queued', 'running')
			  LIMIT 1`,
      [target.resourceKey],
    );
    return result.rows[0]?.id ?? null;
  }
  const result = await client.query<{ id: string }>(
    `SELECT id
		   FROM agent_work_items
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND status IN ('queued', 'running')
		  LIMIT 1`,
    [target.resourceKey, target.lens],
  );
  return result.rows[0]?.id ?? null;
}
