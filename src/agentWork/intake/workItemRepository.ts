import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../../errors/appError.ts";
import type { ReplyTarget } from "../types.ts";
import type {
  AckTarget,
  AskWorkPayload,
  CodeAnchor,
  DescriptionWorkPayload,
  ReviewWorkPayload,
  TriageMode,
  TriageScope,
  TriageWorkPayload,
  VerificationWorkPayload,
} from "../types.ts";
import type { ReviewMode, WorkSource } from "../../review/reviewSchema.ts";
import { reviewCancelLastError, type ReviewCancelAttribution } from "../../settings/index.ts";
import { prResourceKey, type PrRef } from "../types.ts";
import { releasePrActorLeaseHeldByWorkItems } from "../prActorLease.ts";
import { parseWorkItemPayload } from "../workItemPayloadSchema.ts";
import { transition } from "../workItemTransitions.ts";
import { unleasedFence } from "../writeFence.ts";

const SLASH_ACTIVE_INDEX_PREDICATE = `source = 'slash'
       AND type IN ('review', 'description', 'triage')
       AND status IN ('queued', 'running')
       AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'`;

const SLASH_ACTIVE_CONFLICT_TARGET = `(resource_key, type, review_lens)
     WHERE ${SLASH_ACTIVE_INDEX_PREDICATE}`;

const VERIFICATION_SLASH_ACTIVE_INDEX_PREDICATE = `source = 'slash'
       AND type = 'verification'
       AND status IN ('queued', 'running')
       AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'`;

const VERIFICATION_SLASH_ACTIVE_CONFLICT_TARGET = `(resource_key, type, review_lens)
     WHERE ${VERIFICATION_SLASH_ACTIVE_INDEX_PREDICATE}`;

const ASK_WEBHOOK_CONFLICT_TARGET = `(webhook_event_id)
		   WHERE type = 'ask' AND webhook_event_id IS NOT NULL`;

const AGENT_WORK_INSERT_COLUMNS = `id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
		   head_sha, review_lens, resource_key, priority, payload`;

const AGENT_WORK_INSERT_VALUES = `$1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb`;

export type ConflictAwareInsertResult =
  | { readonly created: true; readonly id: string }
  | { readonly created: false; readonly id: string };

export type SlashActiveWorkInsertResult = ConflictAwareInsertResult;

export type ReviewLifecycleObservation = {
  readonly state: "open" | "closed" | "merged";
  readonly observedAt: string;
};

export async function loadReviewLifecycle(client: PoolClient, resourceKey: string) {
  const { rows } = await client.query<{ state: ReviewLifecycleObservation["state"] }>(
    "SELECT state FROM pr_review_lifecycle WHERE resource_key = $1",
    [resourceKey],
  );
  return rows[0];
}
export async function reviewLifecycleObservationAccepted(
  client: PoolClient,
  resourceKey: string,
  observation: ReviewLifecycleObservation,
) {
  const { rows } = await client.query<{ accepted: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM pr_review_lifecycle
       WHERE resource_key = $1
         AND NOT (state <> 'merged'
           AND ($3::timestamptz > observed_at
             OR ($3::timestamptz = observed_at
               AND ($2 = 'merged' OR ($2 = 'closed' AND state = 'open')))))
     ) AS accepted`,
    [resourceKey, observation.state, observation.observedAt],
  );
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(rows[0]?.accepted ?? false);
}

export async function recordReviewLifecycleObservation(
  client: PoolClient,
  resourceKey: string,
  observation: ReviewLifecycleObservation,
  webhookEventId: string,
) {
  const { rows } = await client.query<{ state: ReviewLifecycleObservation["state"] }>(
    `INSERT INTO pr_review_lifecycle (resource_key, state, observed_at, webhook_event_id)
     VALUES ($1, $2, $3::timestamptz, $4)
     ON CONFLICT (resource_key) DO UPDATE
       SET state = EXCLUDED.state,
           observed_at = EXCLUDED.observed_at,
           webhook_event_id = EXCLUDED.webhook_event_id,
           updated_at = now()
     WHERE pr_review_lifecycle.state <> 'merged'
       AND (EXCLUDED.observed_at > pr_review_lifecycle.observed_at
         OR (EXCLUDED.observed_at = pr_review_lifecycle.observed_at
           AND (EXCLUDED.state = 'merged'
             OR (EXCLUDED.state = 'closed' AND pr_review_lifecycle.state = 'open'))))
     RETURNING state`,
    [resourceKey, observation.state, observation.observedAt, webhookEventId],
  );
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(rows[0] != null);
}

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
      readonly source: WorkSource;
      readonly reviewLens: null;
      readonly payload: VerificationWorkPayload;
      readonly conflict: "none" | "slash_active_verification";
    })
  | (AgentWorkInsertCommon & {
      readonly type: "ask";
      readonly source: "slash";
      readonly reviewLens: null;
      readonly payload: AskWorkPayload;
      readonly conflict: "ask_webhook";
    });

function insertParams(params: AgentWorkInsert) {
  return ((pinnedReturn: unknown[]) => pinnedReturn)([
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
  ]);
}

async function insertOnSlashActiveConflict(
  client: PoolClient,
  values: unknown[],
  conflictTarget: string,
) {
  const result = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO agent_work_items (
		   ${AGENT_WORK_INSERT_COLUMNS}
		 )
		 VALUES (${AGENT_WORK_INSERT_VALUES})
		 ON CONFLICT ${conflictTarget}
		 DO UPDATE SET updated_at = agent_work_items.updated_at
		 RETURNING id, (id = $1::uuid) AS created`,
    values,
  );
  const winner = result.rows[0];
  if (!winner) {
    throw new AppError({
      domain: "agent_work",
      kind: "slash_active_conflict_no_winner",
      message: "slash active resolution returned no work item",
    });
  }
  return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
    pinnedReturn)(
    winner.created ? { created: true, id: winner.id } : { created: false, id: winner.id },
  );
}

async function insertAgentWorkItem(client: PoolClient, params: AgentWorkInsert) {
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
      return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
        pinnedReturn)({ created: true, id: params.id });
    }
    case "slash_active":
      return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
        pinnedReturn)(insertOnSlashActiveConflict(client, values, SLASH_ACTIVE_CONFLICT_TARGET));
    case "slash_active_verification":
      return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
        pinnedReturn)(
        insertOnSlashActiveConflict(client, values, VERIFICATION_SLASH_ACTIVE_CONFLICT_TARGET),
      );
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
        return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
          pinnedReturn)({ created: true, id: createdId });
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
          domain: "agent_work",
          kind: "ask_conflict_no_row",
          message: "ask work item conflict without existing row",
        });
      }
      return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
        pinnedReturn)({ created: false, id: existingId });
    }
    default: {
      const exhaustive: never = params;
      throw new AppError({
        domain: "agent_work",
        kind: "unreachable_insert",
        message: `unreachable agent work insert: ${JSON.stringify(exhaustive)}`,
        context: { params: exhaustive },
      });
    }
  }
}

export async function transferProgressCommentOwnership(
  client: PoolClient,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ReviewMode;
  },
) {
  await client.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, detail)
			 VALUES ($1, $2, $3, $4, 'progress_comment', 'pending', '{"progressGeneration":0}'::jsonb)
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
			 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
			               status = 'pending',
			               detail = jsonb_set(
			                 COALESCE(publish_records.detail, '{}'::jsonb),
			                 '{progressGeneration}',
			                 to_jsonb(
			                   COALESCE((publish_records.detail->>'progressGeneration')::integer, 0) + 1
			                 ),
			                 true
			               ) - 'progressRevision',
			               updated_at = now()
			         WHERE publish_records.work_item_id IS DISTINCT FROM EXCLUDED.work_item_id`,
    [crypto.randomUUID(), params.workItemId, params.resourceKey, params.reviewLens],
  );
}

type ReviewWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
  priority?: number;
  userSupplement?: string;
  commenterId?: number;
  ackTargets?: readonly AckTarget[];
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
) {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const webhookTiming = await client.query<{ received_at: Date | string }>(
    "SELECT received_at FROM webhook_events WHERE id = $1",
    [params.webhookEventId],
  );
  const rawReceivedAt = webhookTiming.rows[0]?.received_at;
  const webhookReceivedAt = rawReceivedAt == null ? undefined : new Date(rawReceivedAt).getTime();
  const payload = {
    mode: "review",
    source: params.source,
    ...(webhookReceivedAt != null ? { webhookReceivedAt } : {}),
    repositorySizeKb: params.ref.repositorySizeKb,
    userSupplement: params.userSupplement,
    commenterId: params.commenterId,
    ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
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
      return ((
        pinnedReturn:
          | (string | SlashActiveWorkInsertResult)
          | Promise<string | SlashActiveWorkInsertResult>,
      ) => pinnedReturn)(insert);
    }
    await transferProgressCommentOwnership(client, {
      workItemId: insert.id,
      resourceKey,
      reviewLens: "review",
    });
    return ((
      pinnedReturn:
        | (string | SlashActiveWorkInsertResult)
        | Promise<string | SlashActiveWorkInsertResult>,
    ) => pinnedReturn)(insert);
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
  await transferProgressCommentOwnership(client, {
    workItemId: insert.id,
    resourceKey,
    reviewLens: "review",
  });
  return ((
    pinnedReturn:
      | (string | SlashActiveWorkInsertResult)
      | Promise<string | SlashActiveWorkInsertResult>,
  ) => pinnedReturn)(insert.id);
}

type DescriptionWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
  userSupplement?: string;
  commenterId?: number;
  ackTargets?: readonly AckTarget[];
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
) {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const payload = {
    source: params.source,
    repositorySizeKb: params.ref.repositorySizeKb,
    userSupplement: params.userSupplement,
    commenterId: params.commenterId,
    ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
  } satisfies DescriptionWorkPayload;

  if (params.source === "slash") {
    return ((
      pinnedReturn:
        | (string | SlashActiveWorkInsertResult)
        | Promise<string | SlashActiveWorkInsertResult>,
    ) => pinnedReturn)(
      insertAgentWorkItem(client, {
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
      }),
    );
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
  return ((
    pinnedReturn:
      | (string | SlashActiveWorkInsertResult)
      | Promise<string | SlashActiveWorkInsertResult>,
  ) => pinnedReturn)(insert.id);
}

export async function createTriageWorkItem(
  client: PoolClient,
  params: {
    webhookEventId: string;
    ref: PrRef;
    commentId: number;
    commenterId?: number;
    scope: TriageScope;
    mode?: TriageMode;
    excludeThreadRootCommentIds?: readonly number[];
    threadAnchorCommentId?: number;
    needsThreadRootResolution?: boolean;
    replyTarget: ReplyTarget;
    ackTargets?: readonly AckTarget[];
  },
) {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  return ((pinnedReturn: SlashActiveWorkInsertResult | Promise<SlashActiveWorkInsertResult>) =>
    pinnedReturn)(
    insertAgentWorkItem(client, {
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
        ...(params.mode != null && params.mode !== "apply" ? { mode: params.mode } : {}),
        ...(params.excludeThreadRootCommentIds != null &&
        params.excludeThreadRootCommentIds.length > 0
          ? { excludeThreadRootCommentIds: params.excludeThreadRootCommentIds }
          : {}),
        threadAnchorCommentId: params.threadAnchorCommentId,
        needsThreadRootResolution: params.needsThreadRootResolution,
        replyTarget: params.replyTarget,
        ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
      } satisfies TriageWorkPayload,
      conflict: "slash_active",
    }),
  );
}

type VerificationWorkItemParams = {
  webhookEventId: string;
  ref: PrRef;
  source?: WorkSource;
  pushBeforeSha?: string;
  ackTargets?: readonly AckTarget[];
};

export async function createVerificationWorkItem(
  client: PoolClient,
  params: VerificationWorkItemParams & { source?: "auto" },
): Promise<string>;
export async function createVerificationWorkItem(
  client: PoolClient,
  params: VerificationWorkItemParams & { source: "slash" },
): Promise<SlashActiveWorkInsertResult>;
export async function createVerificationWorkItem(
  client: PoolClient,
  params: VerificationWorkItemParams & { source?: WorkSource },
) {
  const id = crypto.randomUUID();
  const resourceKey = prResourceKey(params.ref.owner, params.ref.repo, params.ref.prNumber);
  const source = params.source ?? "auto";
  if (source === "slash") {
    return ((
      pinnedReturn:
        | (string | SlashActiveWorkInsertResult)
        | Promise<string | SlashActiveWorkInsertResult>,
    ) => pinnedReturn)(
      insertAgentWorkItem(client, {
        id,
        webhookEventId: params.webhookEventId,
        type: "verification",
        source,
        ref: params.ref,
        reviewLens: null,
        resourceKey,
        priority: 50,
        payload: {
          source,
          repositorySizeKb: params.ref.repositorySizeKb,
          ...(params.pushBeforeSha != null ? { pushBeforeSha: params.pushBeforeSha } : {}),
          ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
        } satisfies VerificationWorkPayload,
        conflict: "slash_active_verification",
      }),
    );
  }
  const insert = await insertAgentWorkItem(client, {
    id,
    webhookEventId: params.webhookEventId,
    type: "verification",
    source,
    ref: params.ref,
    reviewLens: null,
    resourceKey,
    priority: 0,
    payload: {
      source,
      repositorySizeKb: params.ref.repositorySizeKb,
      ...(params.pushBeforeSha != null ? { pushBeforeSha: params.pushBeforeSha } : {}),
      ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
    } satisfies VerificationWorkPayload,
    conflict: "none",
  });
  return ((
    pinnedReturn:
      | (string | SlashActiveWorkInsertResult)
      | Promise<string | SlashActiveWorkInsertResult>,
  ) => pinnedReturn)(insert.id);
}

export async function fetchActiveVerificationWorkItem(client: PoolClient, resourceKey: string) {
  const result = await client.query<{ id: string }>(
    `SELECT id
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND type = 'verification'
			    AND status IN ('queued', 'running')
			  LIMIT 1`,
    [resourceKey],
  );
  const row = result.rows[0];
  if (!row)
    return ((pinnedReturn: ({ id: string } | null) | Promise<{ id: string } | null>) =>
      pinnedReturn)(null);
  return ((pinnedReturn: ({ id: string } | null) | Promise<{ id: string } | null>) => pinnedReturn)(
    { id: row.id },
  );
}

export async function fetchActiveTriageWorkItem(
  client: PoolClient,
  resourceKey: string,
  winnerId: string,
) {
  const result = await client.query<{ id: string; payload: unknown }>(
    `SELECT id, payload
			   FROM agent_work_items
			  WHERE resource_key = $1
			    AND id = $2
			    AND type = 'triage'
			    AND ${SLASH_ACTIVE_INDEX_PREDICATE}
			  LIMIT 1`,
    [resourceKey, winnerId],
  );
  const row = result.rows[0];
  if (!row)
    return ((
      pinnedReturn:
        | ({ id: string; payload: TriageWorkPayload } | null)
        | Promise<{ id: string; payload: TriageWorkPayload } | null>,
    ) => pinnedReturn)(null);
  return ((
    pinnedReturn:
      | ({ id: string; payload: TriageWorkPayload } | null)
      | Promise<{ id: string; payload: TriageWorkPayload } | null>,
  ) => pinnedReturn)({ id: row.id, payload: parseWorkItemPayload("triage", row.payload) });
}

export type CancelledActiveReview = {
  readonly id: string;
  readonly source: WorkSource;
  readonly headSha: string;
};

export type CancelledActiveTriage = {
  readonly id: string;
  readonly source: WorkSource;
  readonly headSha: string;
  readonly ackTargets: readonly AckTarget[];
  readonly replyTarget: ReplyTarget;
};

function sortWorkItemsByCreatedAtDesc<T extends { id: string; created_at: Date | string }>(
  rows: readonly T[],
) {
  return ((pinnedReturn: T[]) => pinnedReturn)(
    [...rows].toSorted((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (tb !== ta) return tb - ta;
      return b.id.localeCompare(a.id);
    }),
  );
}

function mapCancelledReviewRows(
  rows: readonly {
    id: string;
    source: WorkSource;
    head_sha: string;
    created_at: Date | string;
  }[],
) {
  return ((pinnedReturn: CancelledActiveReview[]) => pinnedReturn)(
    sortWorkItemsByCreatedAtDesc(rows).map((row) => ({
      id: row.id,
      source: row.source,
      headSha: row.head_sha,
    })),
  );
}

function mapCancelledTriageRows(
  rows: readonly {
    id: string;
    source: WorkSource;
    head_sha: string;
    created_at: Date | string;
    payload: unknown;
  }[],
  prNumber: number | undefined,
) {
  return ((pinnedReturn: CancelledActiveTriage[]) => pinnedReturn)(
    sortWorkItemsByCreatedAtDesc(rows).map((row) => {
      const payload = parseWorkItemPayload("triage", row.payload);
      return {
        id: row.id,
        source: row.source,
        headSha: row.head_sha,
        ackTargets: triageAckTargets(payload, prNumber),
        replyTarget: payload.replyTarget,
      };
    }),
  );
}

export async function cancelActiveReviews(
  client: PoolClient,
  resourceKey: string,
  attribution: ReviewCancelAttribution,
) {
  const payloadPatch = JSON.stringify({ cancelAttribution: attribution });
  const lastError = reviewCancelLastError(attribution);

  const cancel = {
    selector: { resourceKey, type: "review" },
    to: "cancelled",
    lastError,
    payloadPatch,
    returning: ["id", "source", "head_sha", "created_at", "execution_epoch"],
  } as const;
  const queued = await transition(client, { ...cancel, from: ["queued"], fence: unleasedFence() });
  const running = await transition(client, {
    ...cancel,
    from: ["running"],
    requestCancel: true,
    fence: unleasedFence(),
  });
  const cancelled = [
    ...mapCancelledReviewRows(running.rows),
    ...mapCancelledReviewRows(queued.rows),
  ];
  const holders = [...running.rows, ...queued.rows]
    .map((row) => ({ workItemId: row.id, leaseEpoch: Number(row.execution_epoch ?? 0) }))
    .filter((holder) => holder.leaseEpoch > 0);
  await releasePrActorLeaseHeldByWorkItems(client, {
    resourceKey,
    workType: "review",
    holders,
  });
  return ((
    pinnedReturn: readonly CancelledActiveReview[] | Promise<readonly CancelledActiveReview[]>,
  ) => pinnedReturn)(cancelled);
}

function triageAckTargets(payload: TriageWorkPayload, prNumber: number | undefined) {
  if (payload.ackTargets != null && payload.ackTargets.length > 0)
    return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)(payload.ackTargets);
  if (prNumber == null) return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)([]);
  return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)([
    { kind: "pr", prNumber },
    payload.replyTarget.kind === "inlineReviewThread"
      ? { kind: "reviewComment", commentId: payload.commentId }
      : { kind: "issueComment", commentId: payload.commentId },
  ]);
}

export async function cancelActiveTriage(
  client: PoolClient,
  resourceKey: string,
  attribution: ReviewCancelAttribution,
  prNumber?: number,
) {
  const payloadPatch = JSON.stringify({ cancelAttribution: attribution });
  const lastError = reviewCancelLastError(attribution);

  const cancel = {
    selector: { resourceKey, type: "triage" },
    to: "cancelled",
    lastError,
    payloadPatch,
    returning: ["id", "source", "head_sha", "created_at", "payload", "execution_epoch"],
  } as const;
  const queued = await transition(client, { ...cancel, from: ["queued"], fence: unleasedFence() });
  const running = await transition(client, {
    ...cancel,
    from: ["running"],
    requestCancel: true,
    fence: unleasedFence(),
  });
  const holders = [...running.rows, ...queued.rows]
    .map((row) => ({ workItemId: row.id, leaseEpoch: Number(row.execution_epoch ?? 0) }))
    .filter((holder) => holder.leaseEpoch > 0);
  await releasePrActorLeaseHeldByWorkItems(client, {
    resourceKey,
    workType: "triage",
    holders,
  });
  return ((
    pinnedReturn: readonly CancelledActiveTriage[] | Promise<readonly CancelledActiveTriage[]>,
  ) => pinnedReturn)([
    ...mapCancelledTriageRows(running.rows, prNumber),
    ...mapCancelledTriageRows(queued.rows, prNumber),
  ]);
}

export async function createAskWorkItem(
  client: PoolClient,
  params: {
    workItemId?: string;
    webhookEventId: string;
    ref: PrRef;
    question: string;
    replyTarget: ReplyTarget;
    commentId: number;
    commenterId: number;
    codeAnchor?: CodeAnchor;
    ackTargets?: readonly AckTarget[];
  },
) {
  const id = params.workItemId ?? crypto.randomUUID();
  const payload = {
    question: params.question,
    replyTarget: params.replyTarget,
    repositorySizeKb: params.ref.repositorySizeKb,
    commentId: params.commentId,
    commenterId: params.commenterId,
    codeAnchor: params.codeAnchor,
    ...(params.ackTargets != null ? { ackTargets: params.ackTargets } : {}),
  } satisfies AskWorkPayload;
  return ((pinnedReturn: ConflictAwareInsertResult | Promise<ConflictAwareInsertResult>) =>
    pinnedReturn)(
    insertAgentWorkItem(client, {
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
    }),
  );
}
