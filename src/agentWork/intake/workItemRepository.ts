import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { TriageScope, TriageWorkPayload, VerificationWorkPayload } from "../types.js";
import type { ReviewMode, WorkSource } from "../../review/reviewSchema.js";
import type { AutoWorkSupersedeTarget } from "../autoWorkEnqueue.js";
import { prResourceKey, type PrRef } from "../types.js";

/** Partial unique index predicate from migrations/014_slash_active_uniqueness.sql */
const SLASH_ACTIVE_UNIQUENESS_CONFLICT_TARGET = `(resource_key, type, review_lens)
     WHERE source = 'slash'
       AND type IN ('review', 'description', 'triage')
       AND status IN ('queued', 'running')
       AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'`;

export type SlashActiveWorkInsertResult =
  | { readonly created: true; readonly id: string }
  | { readonly created: false; readonly id: string };

async function insertQueuedAgentWorkItem(
  client: PoolClient,
  params: {
    id: string;
    webhookEventId: string;
    type: "review" | "description" | "triage" | "verification";
    source: WorkSource;
    ref: PrRef;
    reviewLens: ReviewMode | null;
    resourceKey: string;
    priority: number;
    payload: unknown;
  },
): Promise<void> {
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

async function insertSlashActiveQueuedWorkItem(
  client: PoolClient,
  params: {
    id: string;
    webhookEventId: string;
    type: "review" | "description" | "triage";
    ref: PrRef;
    reviewLens: ReviewMode | null;
    resourceKey: string;
    priority: number;
    payload: unknown;
  },
): Promise<SlashActiveWorkInsertResult> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, review_lens, resource_key, priority, payload
		 )
		 VALUES ($1, $2, $3, 'slash', 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
		 ON CONFLICT ${SLASH_ACTIVE_UNIQUENESS_CONFLICT_TARGET}
		 DO NOTHING
		 RETURNING id`,
    [
      params.id,
      params.webhookEventId,
      params.type,
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
  const createdId = result.rows[0]?.id;
  if (createdId) {
    return { created: true, id: createdId };
  }

  const existingId = await fetchActiveSlashUniquePeerId(client, {
    resourceKey: params.resourceKey,
    type: params.type,
    reviewLens: params.reviewLens,
  });
  if (!existingId) {
    throw new Error(
      `slash active uniqueness conflict without winner for ${params.resourceKey} ${params.type}`,
    );
  }
  return { created: false, id: existingId };
}

async function fetchActiveSlashUniquePeerId(
  client: PoolClient,
  params: {
    resourceKey: string;
    type: "review" | "description" | "triage";
    reviewLens: ReviewMode | null;
  },
): Promise<string | null> {
  if (params.type === "review") {
    const result = await client.query<{ id: string }>(
      `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = 'review'
			    AND review_lens = $2
			    AND source = 'slash'
			    AND status IN ('queued', 'running')
			    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'
			  LIMIT 1`,
      [params.resourceKey, params.reviewLens],
    );
    return result.rows[0]?.id ?? null;
  }

  const result = await client.query<{ id: string }>(
    `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = $2
			    AND source = 'slash'
			    AND status IN ('queued', 'running')
			    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'
			  LIMIT 1`,
    [params.resourceKey, params.type],
  );
  return result.rows[0]?.id ?? null;
}

type ReviewWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
  lens: ReviewMode;
  priority?: number;
  userSupplement?: string;
  commenterId?: number;
};

export async function createReviewWorkItem(
  client: PoolClient,
  params: ReviewWorkItemParams & { source: "auto" },
): Promise<string>;
export async function createReviewWorkItem(
  client: PoolClient,
  params: ReviewWorkItemParams & { source: "slash" },
): Promise<SlashActiveWorkInsertResult>;
export async function createReviewWorkItem(
  client: PoolClient,
  params: ReviewWorkItemParams & { source: WorkSource },
): Promise<string | SlashActiveWorkInsertResult> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const payload = {
    mode: params.lens,
    source: params.source,
    repositorySizeKb: params.ref.repositorySizeKb,
    userSupplement: params.userSupplement,
    commenterId: params.commenterId,
  };

  if (params.source === "slash") {
    const insert = await insertSlashActiveQueuedWorkItem(client, {
      id,
      webhookEventId: params.webhookEventId,
      type: "review",
      ref: params.ref,
      reviewLens: params.lens,
      resourceKey,
      priority: params.priority ?? 0,
      payload,
    });
    if (!insert.created) {
      return insert;
    }
    await client.query(
      `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status)
			 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending')
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
			 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
			               status = 'pending',
			               updated_at = now()`,
      [crypto.randomUUID(), insert.id, resourceKey, params.lens],
    );
    return insert;
  }

  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "review",
    source: "auto",
    ref: params.ref,
    reviewLens: params.lens,
    resourceKey,
    priority: params.priority ?? 0,
    payload,
  });
  await client.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status)
			 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending')
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
			 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
			               status = 'pending',
			               updated_at = now()`,
    [crypto.randomUUID(), id, resourceKey, params.lens],
  );
  return id;
}

type DescriptionWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
  userSupplement?: string;
  commenterId?: number;
};

export async function createDescriptionWorkItem(
  client: PoolClient,
  params: DescriptionWorkItemParams & { source: "auto" },
): Promise<string>;
export async function createDescriptionWorkItem(
  client: PoolClient,
  params: DescriptionWorkItemParams & { source: "slash" },
): Promise<SlashActiveWorkInsertResult>;
export async function createDescriptionWorkItem(
  client: PoolClient,
  params: DescriptionWorkItemParams & { source: WorkSource },
): Promise<string | SlashActiveWorkInsertResult> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const payload = {
    source: params.source,
    repositorySizeKb: params.ref.repositorySizeKb,
    userSupplement: params.userSupplement,
    commenterId: params.commenterId,
  };

  if (params.source === "slash") {
    return insertSlashActiveQueuedWorkItem(client, {
      id,
      webhookEventId: params.webhookEventId,
      type: "description",
      ref: params.ref,
      reviewLens: null,
      resourceKey,
      priority: 50,
      payload,
    });
  }

  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "description",
    source: "auto",
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: 0,
    payload,
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
    needsThreadRootResolution?: boolean;
    replyTarget: ReplyTarget;
  },
): Promise<SlashActiveWorkInsertResult> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  return insertSlashActiveQueuedWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "triage",
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
      needsThreadRootResolution: params.needsThreadRootResolution,
      replyTarget: params.replyTarget,
    } satisfies TriageWorkPayload,
  });
}

export async function createVerificationWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  await insertQueuedAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "verification",
    source: "auto",
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: 0,
    payload: {
      source: "auto",
      repositorySizeKb: params.ref.repositorySizeKb,
    } satisfies VerificationWorkPayload,
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
): Promise<
  { readonly created: true; readonly id: string } | { readonly created: false; readonly id: string }
> {
  const id = crypto.randomUUID();
  const payload = {
    question: params.question,
    replyTarget: params.replyTarget,
    repositorySizeKb: params.ref.repositorySizeKb,
    commentId: params.commentId,
    commenterId: params.commenterId,
    codeAnchor: params.codeAnchor,
  };
  const result = await client.query<{ id: string }>(
    `INSERT INTO agent_work_items (
		   id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, resource_key, priority, payload
		 )
		 VALUES ($1, $2, 'ask', 'slash', 'queued', $3, $4, $5, $6, $7, $8, 50, $9::jsonb)
		 ON CONFLICT (webhook_event_id)
		   WHERE type = 'ask' AND webhook_event_id IS NOT NULL
		 DO NOTHING
		 RETURNING id`,
    [
      id,
      params.webhookEventId,
      params.ref.owner,
      params.ref.repo,
      params.ref.prNumber,
      params.ref.installationId,
      params.ref.headSha,
      prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber),
      JSON.stringify(payload),
    ],
  );
  const createdId = result.rows[0]?.id;
  if (createdId) {
    return { created: true, id: createdId };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM agent_work_items
      WHERE webhook_event_id = $1
        AND type = 'ask'
      LIMIT 1`,
    [params.webhookEventId],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error("ask work item conflict without existing row");
  }
  return { created: false, id: existingId };
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
  if (target.kind === "verification") {
    const result = await client.query<{ id: string }>(
      `SELECT id
		   FROM agent_work_items
		  WHERE resource_key = $1
		    AND type = 'verification'
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
