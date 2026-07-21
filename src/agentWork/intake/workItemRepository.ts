import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../../errors/appError.js";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import type { ReplyTarget } from "../../commands/replyTarget.js";
import type {
  AskWorkPayload,
  DescriptionWorkPayload,
  ReviewWorkPayload,
  TriageScope,
  TriageWorkPayload,
  VerificationWorkPayload,
} from "../types.js";
import type { ReviewMode, WorkSource } from "../../review/reviewSchema.js";
import { prResourceKey, type PrRef } from "../types.js";
import { parseWorkItemPayload } from "../workItemPayloadSchema.js";

/**
 * Partial unique index predicate from migrations/014_slash_active_uniqueness.sql.
 * Keep ON CONFLICT inference and winner SELECT in lockstep with that index.
 */
const SLASH_ACTIVE_INDEX_PREDICATE = `source = 'slash'
       AND type IN ('review', 'description', 'triage')
       AND status IN ('queued', 'running')
       AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'`;

const SLASH_ACTIVE_CONFLICT_TARGET = `(resource_key, type, review_lens)
     WHERE ${SLASH_ACTIVE_INDEX_PREDICATE}`;

/** Partial unique index from migrations/015_thread_reply_classification.sql */
const ASK_WEBHOOK_CONFLICT_TARGET = `(webhook_event_id)
		   WHERE type = 'ask' AND webhook_event_id IS NOT NULL`;

const AGENT_WORK_INSERT_COLUMNS = `id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, review_lens, resource_key, priority, payload`;

const AGENT_WORK_INSERT_VALUES = `$1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb`;

export type ConflictAwareInsertResult =
  | { readonly created: true; readonly id: string }
  | { readonly created: false; readonly id: string };

export type SlashActiveWorkInsertResult = ConflictAwareInsertResult;

type AgentWorkInsertCommon = {
  readonly id: string;
  readonly webhookEventId: string;
  readonly ref: PrRef;
  readonly resourceKey: string;
  readonly priority: number;
};

type AgentWorkInsert =
  | (AgentWorkInsertCommon & {
      readonly type: "review";
      readonly source: WorkSource;
      readonly reviewLens: ReviewMode;
      readonly payload: ReviewWorkPayload;
      readonly conflict: "none" | "slash_active";
    })
  | (AgentWorkInsertCommon & {
      readonly type: "description";
      readonly source: WorkSource;
      readonly reviewLens: null;
      readonly payload: DescriptionWorkPayload;
      readonly conflict: "none" | "slash_active";
    })
  | (AgentWorkInsertCommon & {
      readonly type: "triage";
      readonly source: "slash";
      readonly reviewLens: null;
      readonly payload: TriageWorkPayload;
      readonly conflict: "slash_active";
    })
  | (AgentWorkInsertCommon & {
      readonly type: "verification";
      readonly source: "auto";
      readonly reviewLens: null;
      readonly payload: VerificationWorkPayload;
      readonly conflict: "none";
    })
  | (AgentWorkInsertCommon & {
      readonly type: "ask";
      readonly source: "slash";
      readonly reviewLens: null;
      readonly payload: AskWorkPayload;
      readonly conflict: "ask_webhook";
    });

function insertParams(params: AgentWorkInsert): unknown[] {
  return [
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
  ];
}

/** Insert with optional uniqueness conflict; winner SELECT is a separate query for READ COMMITTED races. */
async function insertAgentWorkItem(
  client: PoolClient,
  params: AgentWorkInsert,
): Promise<ConflictAwareInsertResult> {
  const values = insertParams(params);
  switch (params.conflict) {
    case "none": {
      await client.query(
        `INSERT INTO agent_work_items (
		   ${AGENT_WORK_INSERT_COLUMNS}
		 )
		 VALUES (${AGENT_WORK_INSERT_VALUES})`,
        values,
      );
      return { created: true, id: params.id };
    }
    case "slash_active": {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_work_items (
		   ${AGENT_WORK_INSERT_COLUMNS}
		 )
		 VALUES (${AGENT_WORK_INSERT_VALUES})
		 ON CONFLICT ${SLASH_ACTIVE_CONFLICT_TARGET}
		 DO NOTHING
		 RETURNING id`,
        values,
      );
      const createdId = inserted.rows[0]?.id;
      if (createdId) {
        return { created: true, id: createdId };
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = $2
			    AND review_lens IS NOT DISTINCT FROM $3
			    AND ${SLASH_ACTIVE_INDEX_PREDICATE}
			  LIMIT 1`,
        [params.resourceKey, params.type, params.reviewLens],
      );
      const existingId = existing.rows[0]?.id;
      if (!existingId) {
        throw new AppError({
          code: "agent_work.slash_active_conflict_no_winner",
          message: `slash active uniqueness conflict without winner for ${params.resourceKey} ${params.type}`,
          context: { resourceKey: params.resourceKey, type: params.type },
        });
      }
      return { created: false, id: existingId };
    }
    case "ask_webhook": {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_work_items (
		   ${AGENT_WORK_INSERT_COLUMNS}
		 )
		 VALUES (${AGENT_WORK_INSERT_VALUES})
		 ON CONFLICT ${ASK_WEBHOOK_CONFLICT_TARGET}
		 DO NOTHING
		 RETURNING id`,
        values,
      );
      const createdId = inserted.rows[0]?.id;
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
        throw new AppError({
          code: "agent_work.ask_conflict_no_row",
          message: "ask work item conflict without existing row",
        });
      }
      return { created: false, id: existingId };
    }
    default: {
      const exhaustive: never = params;
      throw new AppError({
        code: "agent_work.unreachable_insert",
        message: `unreachable agent work insert: ${JSON.stringify(exhaustive)}`,
        context: { params: exhaustive },
      });
    }
  }
}

async function ensureProgressCommentRecord(
  client: PoolClient,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ReviewMode;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status)
			 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending')
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
			 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
			               status = 'pending',
			               updated_at = now()`,
    [crypto.randomUUID(), params.workItemId, params.resourceKey, params.reviewLens],
  );
}

type ReviewWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
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
    mode: "review",
    source: params.source,
    repositorySizeKb: params.ref.repositorySizeKb,
    userSupplement: params.userSupplement,
    commenterId: params.commenterId,
  } satisfies ReviewWorkPayload;

  if (params.source === "slash") {
    const insert = await insertAgentWorkItem(client, {
      id,
      webhookEventId: params.webhookEventId,
      type: "review",
      source: "slash",
      ref: params.ref,
      reviewLens: "review",
      resourceKey,
      priority: params.priority ?? 0,
      payload,
      conflict: "slash_active",
    });
    if (!insert.created) {
      return insert;
    }
    await ensureProgressCommentRecord(client, {
      workItemId: insert.id,
      resourceKey,
      reviewLens: "review",
    });
    return insert;
  }

  const insert = await insertAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "review",
    source: "auto",
    ref: params.ref,
    reviewLens: "review",
    resourceKey,
    priority: params.priority ?? 0,
    payload,
    conflict: "none",
  });
  await ensureProgressCommentRecord(client, {
    workItemId: insert.id,
    resourceKey,
    reviewLens: "review",
  });
  return insert.id;
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
  } satisfies DescriptionWorkPayload;

  if (params.source === "slash") {
    return insertAgentWorkItem(client, {
      id,
      webhookEventId: params.webhookEventId,
      type: "description",
      source: "slash",
      ref: params.ref,
      reviewLens: null,
      resourceKey,
      priority: 50,
      payload,
      conflict: "slash_active",
    });
  }

  const insert = await insertAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "description",
    source: "auto",
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: 0,
    payload,
    conflict: "none",
  });
  return insert.id;
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
  return insertAgentWorkItem(client, {
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
      needsThreadRootResolution: params.needsThreadRootResolution,
      replyTarget: params.replyTarget,
    } satisfies TriageWorkPayload,
    conflict: "slash_active",
  });
}

export async function createVerificationWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
    pushBeforeSha?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const insert = await insertAgentWorkItem(client, {
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
      ...(params.pushBeforeSha != null ? { pushBeforeSha: params.pushBeforeSha } : {}),
    } satisfies VerificationWorkPayload,
    conflict: "none",
  });
  return insert.id;
}

export async function fetchActiveTriageWorkItem(
  client: PoolClient,
  resourceKey: string,
): Promise<{ id: string; payload: TriageWorkPayload } | null> {
  const result = await client.query<{ id: string; payload: unknown }>(
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
  return { id: row.id, payload: parseWorkItemPayload("triage", row.payload) };
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
): Promise<ConflictAwareInsertResult> {
  const id = crypto.randomUUID();
  const payload = {
    question: params.question,
    replyTarget: params.replyTarget,
    repositorySizeKb: params.ref.repositorySizeKb,
    commentId: params.commentId,
    commenterId: params.commenterId,
    codeAnchor: params.codeAnchor,
  } satisfies AskWorkPayload;
  return insertAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "ask",
    source: "slash",
    ref: params.ref,
    reviewLens: null,
    resourceKey: prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber),
    priority: 50,
    payload,
    conflict: "ask_webhook",
  });
}
