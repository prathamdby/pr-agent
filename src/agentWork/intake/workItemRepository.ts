import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { CodeAnchor } from "../../agent/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { TriageScope, TriageWorkPayload } from "../types.js";
import type { ReviewMode, WorkSource } from "../../review/reviewSchema.js";
import type { AutoWorkSupersedeTarget } from "../autoWorkEnqueue.js";
import { prResourceKey, type PrRef } from "../types.js";

async function insertQueuedAgentWorkItem(
  client: PoolClient,
  params: {
    id: string;
    webhookEventId: string;
    type: "review" | "description" | "ask" | "triage";
    source: WorkSource;
    ref: PrRef;
    reviewLens: ReviewMode | null;
    resourceKey: string;
    priority: number;
    payload: unknown;
  },
): Promise<void> {
  if (params.type === "ask") {
    await client.query(
      `INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, resource_key, priority, payload
		 )
		 VALUES ($1, $2, 'ask', $3, 'queued', $4, $5, $6, $7, $8, $9, 50, $10::jsonb)`,
      [
        params.id,
        params.webhookEventId,
        params.source,
        params.ref.owner,
        params.ref.repo,
        params.ref.prNumber,
        params.ref.installationId,
        params.ref.headSha,
        params.resourceKey,
        JSON.stringify(params.payload),
      ],
    );
    return;
  }

  await client.query(
    `INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, review_lens, resource_key, priority, payload
		 )
		 VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      params.id,
      params.webhookEventId,
      params.type,
      params.source,
      params.ref.owner,
      params.ref.repo,
      params.ref.prNumber,
      params.ref.installationId,
      params.ref.headSha,
      params.reviewLens,
      params.resourceKey,
      params.priority,
      JSON.stringify(params.payload),
    ],
  );
}

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
  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "review",
    source: params.source,
    ref: params.ref,
    reviewLens: params.lens,
    resourceKey,
    priority: params.priority ?? 0,
    payload: {
      mode: params.lens,
      source: params.source,
      repositorySizeKb: params.ref.repositorySizeKb,
      userSupplement: params.userSupplement,
      commenterId: params.commenterId,
    },
  });
  await client.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status)
			 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending')
			 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask'
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
  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "description",
    source: params.source,
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: params.source === "slash" ? 50 : 0,
    payload: {
      source: params.source,
      repositorySizeKb: params.ref.repositorySizeKb,
      userSupplement: params.userSupplement,
      commenterId: params.commenterId,
    },
  });
  return id;
}

export async function createTriageWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
    commentId: number;
    commenterId?: number;
    scope: TriageScope;
    threadAnchorCommentId?: number;
    replyTarget: ReplyTarget;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "triage",
    source: "slash",
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: 50,
    payload: {
      source: "slash",
      repositorySizeKb: params.ref.repositorySizeKb,
      commentId: params.commentId,
      commenterId: params.commenterId,
      scope: params.scope,
      threadAnchorCommentId: params.threadAnchorCommentId,
      replyTarget: params.replyTarget,
    } satisfies TriageWorkPayload,
  });
  return id;
}

export async function fetchActiveTriageWorkItem(
  client: PoolClient,
  resourceKey: string,
): Promise<{ id: string; payload: TriageWorkPayload } | null> {
  const result = await client.query<{ id: string; payload: TriageWorkPayload }>(
    `SELECT id, payload
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = 'triage'
			    AND status IN ('queued', 'running')
			  LIMIT 1`,
    [resourceKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, payload: row.payload };
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
  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "ask",
    source: "slash",
    ref: params.ref,
    reviewLens: null,
    resourceKey: prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber),
    priority: 50,
    payload: {
      question: params.question,
      replyTarget: params.replyTarget,
      repositorySizeKb: params.ref.repositorySizeKb,
      commentId: params.commentId,
      commenterId: params.commenterId,
      codeAnchor: params.codeAnchor,
    },
  });
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
  if (target.kind === "triage") {
    const result = await client.query<{ id: string }>(
      `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = 'triage'
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
