import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { inTransaction, pgBossDb } from "../db/postgres.js";
import { AppError, isAppError } from "../errors/appError.js";
import { logError, logInfo } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { ACK_QUEUE, DEFERRED_HEAD_SHA, REVIEW_QUEUE } from "../settings/index.js";
import { acquireAutoWorkIntakeLock } from "./autoWorkEnqueue.js";
import {
  loadReviewLifecycle,
  transferProgressCommentOwnership,
} from "./intake/workItemRepository.js";
import { lockPrActorLeaseForUpdate } from "./prActorLease.js";
import { getWorkItem, markQueuedWorkCancelled } from "./workItemStateRepository.js";
import {
  installationGroupId,
  type ReviewWorkItem,
  type AckJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
  type StaleHeadReplacement,
} from "./types.js";
import { STALE_HEAD_REPLACEMENT_ID_SQL } from "./workItemPayloadSchema.js";

export const STALE_HEAD_PARENT_NOT_RESCHEDULABLE = "agent_work.stale_head_parent_not_reschedulable";
export const STALE_HEAD_REPLACEMENT_EXHAUSTED = "review.stale_head_replacement_exhausted";

export type StaleReviewRescheduleResult = {
  readonly kind: "rescheduled";
  readonly replacementWorkItemId: string;
  readonly afterComplete: (boss: PgBoss) => Promise<void>;
};

type ReviewRescheduleWorkItem = {
  readonly replacementWorkItemId: string;
  readonly headSha: string;
};

export function isStaleHeadParentNotReschedulable(error: unknown): boolean {
  return isAppError(error) && error.code === STALE_HEAD_PARENT_NOT_RESCHEDULABLE;
}

export function isStaleHeadReplacementExhausted(error: unknown): boolean {
  return isAppError(error) && error.code === STALE_HEAD_REPLACEMENT_EXHAUSTED;
}

/** One-shot replacement already consumed; caller should fail with `/review` retry guidance. */
export function staleHeadReplacementExhaustedError(item: ReviewWorkItem): AppError {
  return new AppError({
    code: STALE_HEAD_REPLACEMENT_EXHAUSTED,
    message: "Stale-head replacement went stale again. Run /review to retry on the latest head.",
    context: { workItemId: item.id, resourceKey: item.resourceKey },
  });
}

/**
 * Terminal parent failure: cancel the parent's replacement unless the persisted
 * marker says its enqueue committed. The attempt that failed may have written the
 * marker after `parent` was loaded, so the parent is read again. The cancellation
 * is state-predicated, so a replacement that won a concurrent claim is still
 * cancelled and queue traffic cannot veto it. Rejects after logging when the
 * cancellation is unconfirmed.
 */
export async function cancelPendingStaleHeadReplacement(
  pool: Pool,
  parent: ReviewWorkItem,
  error: unknown,
): Promise<void> {
  let replacementWorkItemId: string | undefined;
  try {
    const current = await getWorkItem(pool, parent.id);
    const replacement =
      current?.type === "review" ? current.payload.staleHeadReplacement : undefined;
    if (!replacement || replacement.state === "enqueued") return;
    replacementWorkItemId = replacement.replacementWorkItemId;
    if (!(await markQueuedWorkCancelled(pool, replacementWorkItemId, error))) {
      throw new AppError({
        code: "agent_work.replacement_cancel_rejected",
        message: "Stale-head replacement cancellation was not confirmed.",
        context: { workItemId: parent.id, replacementWorkItemId },
      });
    }
  } catch (cancelError) {
    logError(
      "agent_work_replacement_cancel_failed",
      {
        type: "review",
        workItemId: parent.id,
        replacementWorkItemId,
        message: sanitizeLogMessage(
          cancelError instanceof Error ? cancelError.message : String(cancelError),
        ),
      },
      cancelError,
    );
    throw cancelError;
  }
}

export async function buildStaleReviewRescheduleResult(
  pool: Pool,
  item: ReviewWorkItem,
  leaseEpoch: number,
): Promise<StaleReviewRescheduleResult> {
  const replacement = await createReviewRescheduleWorkItem(pool, item, leaseEpoch);
  return {
    kind: "rescheduled",
    replacementWorkItemId: replacement.replacementWorkItemId,
    afterComplete: async (boss) => {
      await enqueueReviewReschedule(
        pool,
        boss,
        item,
        replacement.replacementWorkItemId,
        replacement.headSha,
        leaseEpoch,
      );
    },
  };
}

/** Like buildStaleReviewRescheduleResult, but null when the parent can no longer own a replacement. */
export async function tryBuildStaleReviewRescheduleResult(
  pool: Pool,
  item: ReviewWorkItem,
  leaseEpoch: number,
): Promise<StaleReviewRescheduleResult | null> {
  try {
    return await buildStaleReviewRescheduleResult(pool, item, leaseEpoch);
  } catch (error) {
    if (isStaleHeadParentNotReschedulable(error)) return null;
    throw error;
  }
}

export async function createReviewRescheduleWorkItem(
  pool: Pool,
  item: ReviewWorkItem,
  leaseEpoch: number,
): Promise<ReviewRescheduleWorkItem> {
  return inTransaction(pool, async (client) => {
    await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey: item.resourceKey });
    const lifecycle = await loadReviewLifecycle(client, item.resourceKey);
    if (lifecycle?.state === "closed" || lifecycle?.state === "merged") {
      throw new AppError({
        code: STALE_HEAD_PARENT_NOT_RESCHEDULABLE,
        message: `Pull request is ${lifecycle.state}; stale-head replacement is not permitted`,
        context: { workItemId: item.id, resourceKey: item.resourceKey },
      });
    }
    await lockPrActorLeaseForUpdate(client, item.id, leaseEpoch);
    const parentLive = await client.query<{ id: string }>(
      `SELECT id FROM agent_work_items
        WHERE id = $1
          AND status = 'running'
          AND cancel_requested_at IS NULL
        FOR UPDATE`,
      [item.id],
    );
    if ((parentLive.rowCount ?? 0) === 0) {
      throw new AppError({
        code: STALE_HEAD_PARENT_NOT_RESCHEDULABLE,
        message: `Parent review ${item.id} is no longer running for stale-head reschedule`,
        context: { workItemId: item.id },
      });
    }

    const payload = item.payload;
    const reviewLens = item.reviewLens;
    let replacementWorkItemId = payload.staleHeadReplacement?.replacementWorkItemId;

    if (!replacementWorkItemId) {
      replacementWorkItemId = crypto.randomUUID();
      const marker = JSON.stringify({
        staleHeadReplacement: {
          replacementWorkItemId,
          state: "pending-enqueue",
        } satisfies StaleHeadReplacement,
      });
      const updateResult = await client.query<{ replacement_id: string }>(
        `UPDATE agent_work_items
         SET payload = (payload
               - 'staleHeadReplacementWorkItemId'
               - 'staleHeadReplacementEnqueued')
             || $2::jsonb,
             updated_at = now()
       WHERE id = $1
         AND ${STALE_HEAD_REPLACEMENT_ID_SQL} IS NULL
       RETURNING ${STALE_HEAD_REPLACEMENT_ID_SQL} AS replacement_id`,
        [item.id, marker],
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        const refreshed = await getWorkItem(client, item.id);
        const persistedId =
          refreshed?.type === "review"
            ? refreshed.payload.staleHeadReplacement?.replacementWorkItemId
            : undefined;
        if (!persistedId) {
          throw new AppError({
            code: "agent_work.stale_head_marker_persist_failed",
            message: `Failed to persist stale-head replacement marker for work item ${item.id}`,
            context: { workItemId: item.id },
          });
        }
        replacementWorkItemId = persistedId;
      } else {
        replacementWorkItemId = updateResult.rows[0].replacement_id;
      }
    }

    const { staleHeadReplacement: _parentReplacement, ...replacementBase } = payload;
    const nextPayload: ReviewWorkPayload = {
      ...replacementBase,
      source: item.source,
      staleHeadRescheduled: true,
    };

    const insertResult = await client.query<{ head_sha: string }>(
      `INSERT INTO agent_work_items (
       id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
       head_sha, review_lens, resource_key, priority, payload
     )
     VALUES ($1, $2, 'review', $3, 'queued', $4, $5, $6, $7, $8, $9, $10, 0, $11::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload || agent_work_items.payload,
       updated_at = now()
     RETURNING head_sha`,
      [
        replacementWorkItemId,
        item.webhookEventId,
        item.source,
        item.owner,
        item.repo,
        item.prNumber,
        item.installationId,
        DEFERRED_HEAD_SHA,
        reviewLens,
        item.resourceKey,
        JSON.stringify(nextPayload),
      ],
    );
    await transferProgressCommentOwnership(client, {
      workItemId: replacementWorkItemId,
      resourceKey: item.resourceKey,
      reviewLens,
    });

    return {
      replacementWorkItemId,
      headSha: insertResult.rows[0].head_sha,
    };
  });
}

async function markStaleHeadReplacementEnqueued(
  client: PoolClient,
  parentId: string,
  replacementWorkItemId: string,
): Promise<void> {
  const enqueued: StaleHeadReplacement = {
    replacementWorkItemId,
    state: "enqueued",
  };
  await client.query(
    `UPDATE agent_work_items
       SET payload = (payload
             - 'staleHeadReplacementWorkItemId'
             - 'staleHeadReplacementEnqueued')
           || $2::jsonb,
           updated_at = now()
     WHERE id = $1
       AND ${STALE_HEAD_REPLACEMENT_ID_SQL} = $3`,
    [parentId, JSON.stringify({ staleHeadReplacement: enqueued }), replacementWorkItemId],
  );
}

async function ensureDeterministicJob(
  boss: PgBoss,
  queue: string,
  data: ReviewJobData | AckJobData,
  options: Parameters<PgBoss["send"]>[2],
  db: ReturnType<typeof pgBossDb>,
): Promise<void> {
  const workItemId = data.workItemId;
  const existing = await boss.findJobs(queue, { db, id: workItemId });
  if (existing.length > 0) return;

  const jobId = await boss.send(queue, data, options);
  if (jobId != null) return;

  throw new AppError({
    code: "agent_work.reschedule_enqueue_failed",
    message: `pg-boss did not enqueue missing ${queue} job for stale-head replacement ${workItemId}`,
    context: { queue, workItemId },
  });
}

export async function enqueueReviewReschedule(
  pool: Pool,
  boss: PgBoss,
  item: ReviewWorkItem,
  workItemId: string,
  replacementHeadSha: string,
  leaseEpoch: number,
): Promise<void> {
  const reviewLens = item.reviewLens;
  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};

  await inTransaction(pool, async (client) => {
    await lockPrActorLeaseForUpdate(client, item.id, leaseEpoch);
    const db = pgBossDb(client);

    const reviewData: ReviewJobData = {
      kind: "review",
      workItemId,
      ...correlation,
    };
    await ensureDeterministicJob(
      boss,
      REVIEW_QUEUE,
      reviewData,
      {
        db,
        id: workItemId,
        group: { id: installationGroupId(item.installationId) },
      },
      db,
    );

    const ackData: AckJobData = {
      kind: "ack",
      workItemId,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      targets: [],
      progress: { lens: reviewLens, headSha: replacementHeadSha, source: item.source },
      ...correlation,
    };
    await ensureDeterministicJob(
      boss,
      ACK_QUEUE,
      ackData,
      {
        db,
        id: workItemId,
        priority: 100,
        group: { id: installationGroupId(item.installationId) },
      },
      db,
    );
    await markStaleHeadReplacementEnqueued(client, item.id, workItemId);
  });

  logInfo("review_stale_head_rescheduled", {
    owner: item.owner,
    repo: item.repo,
    pr: item.prNumber,
    reviewLens,
    previousWorkItemId: item.id,
    replacementWorkItemId: workItemId,
    previousHeadSha: item.headSha,
    replacementHeadSha,
  });
}
