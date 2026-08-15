import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { inTransaction, pgBossDb } from "../db/postgres.js";
import { AppError, isAppError } from "../errors/appError.js";
import { logInfo, logWarn } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { ACK_QUEUE, DEFERRED_HEAD_SHA, REVIEW_QUEUE } from "../settings/index.js";
import { transferProgressCommentOwnership } from "./intake/workItemRepository.js";
import { getWorkItem, markQueuedWorkCancelled } from "./repository.js";
import {
  installationGroupId,
  type ReviewWorkItem,
  type AckJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
} from "./types.js";

export const STALE_HEAD_PARENT_NOT_RESCHEDULABLE = "agent_work.stale_head_parent_not_reschedulable";
export const STALE_HEAD_REPLACEMENT_EXHAUSTED = "review.stale_head_replacement_exhausted";

export type StaleReviewRescheduleResult = {
  readonly rescheduled: true;
  readonly replacementWorkItemId: string;
  readonly afterComplete: (boss: PgBoss) => Promise<void>;
  /** Cancel a persisted-but-not-enqueued replacement when the parent fails terminally. */
  readonly onRescheduleAbort: (boss: PgBoss, error: unknown) => Promise<void>;
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
 * Cancel a queued stale-head replacement that was persisted but never enqueued.
 * Uses the known replacement id from the reschedule result — no payload re-fetch/re-parse.
 * No-ops when enqueue succeeded in this attempt or a replacement review job is live.
 */
export async function cancelUnenqueuedStaleHeadReplacement(
  pool: Pool,
  boss: PgBoss,
  parent: ReviewWorkItem,
  replacementWorkItemId: string,
  error: unknown,
  replacementEnqueued: boolean,
): Promise<void> {
  if (replacementEnqueued) return;
  try {
    if (await replacementReviewJobExists(boss, replacementWorkItemId)) return;
    if (!(await markQueuedWorkCancelled(pool, replacementWorkItemId, error))) {
      logWarn("agent_work_replacement_cancel_failed", {
        type: "review",
        workItemId: parent.id,
        replacementWorkItemId,
      });
    }
  } catch (cancelError) {
    logWarn("agent_work_replacement_cancel_failed", {
      type: "review",
      workItemId: parent.id,
      replacementWorkItemId,
      message: sanitizeLogMessage(
        cancelError instanceof Error ? cancelError.message : String(cancelError),
      ),
    });
  }
}

/**
 * Terminal-failure fallback when no in-attempt `onRescheduleAbort` was registered.
 * An earlier attempt may have stamped `staleHeadReplacementWorkItemId` and inserted a
 * queued replacement, then crashed before enqueue — the next terminal attempt throws
 * before `execute` returns a reschedule result, so the abort hook never attaches.
 */
export async function cancelOrphanedStaleHeadReplacementOnTerminalFailure(
  pool: Pool,
  boss: PgBoss,
  parent: ReviewWorkItem,
  error: unknown,
): Promise<void> {
  const replacementWorkItemId = parent.payload.staleHeadReplacementWorkItemId;
  if (!replacementWorkItemId) return;
  await cancelUnenqueuedStaleHeadReplacement(
    pool,
    boss,
    parent,
    replacementWorkItemId,
    error,
    Boolean(parent.payload.staleHeadReplacementEnqueued),
  );
}

export async function buildStaleReviewRescheduleResult(
  pool: Pool,
  item: ReviewWorkItem,
): Promise<StaleReviewRescheduleResult> {
  const replacement = await createReviewRescheduleWorkItem(pool, item);
  let replacementEnqueued = false;
  return {
    rescheduled: true,
    replacementWorkItemId: replacement.replacementWorkItemId,
    afterComplete: async (boss) => {
      await enqueueReviewReschedule(
        pool,
        boss,
        item,
        replacement.replacementWorkItemId,
        replacement.headSha,
      );
      replacementEnqueued = true;
    },
    onRescheduleAbort: async (boss, error) => {
      await cancelUnenqueuedStaleHeadReplacement(
        pool,
        boss,
        item,
        replacement.replacementWorkItemId,
        error,
        replacementEnqueued,
      );
    },
  };
}

/** Like buildStaleReviewRescheduleResult, but null when the parent can no longer own a replacement. */
export async function tryBuildStaleReviewRescheduleResult(
  pool: Pool,
  item: ReviewWorkItem,
): Promise<StaleReviewRescheduleResult | null> {
  try {
    return await buildStaleReviewRescheduleResult(pool, item);
  } catch (error) {
    if (isStaleHeadParentNotReschedulable(error)) return null;
    throw error;
  }
}

export async function createReviewRescheduleWorkItem(
  pool: Pool,
  item: ReviewWorkItem,
): Promise<ReviewRescheduleWorkItem> {
  return inTransaction(pool, async (client) => {
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
    let replacementWorkItemId = payload.staleHeadReplacementWorkItemId;

    if (!replacementWorkItemId) {
      replacementWorkItemId = crypto.randomUUID();
      const marker = JSON.stringify({
        staleHeadReplacementWorkItemId: replacementWorkItemId,
      });
      const updateResult = await client.query<{ replacement_id: string }>(
        `UPDATE agent_work_items
         SET payload = payload || $2::jsonb,
             updated_at = now()
       WHERE id = $1
         AND (payload->>'staleHeadReplacementWorkItemId') IS NULL
       RETURNING payload->>'staleHeadReplacementWorkItemId' AS replacement_id`,
        [item.id, marker],
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        const refreshed = await getWorkItem(pool, item.id);
        if (refreshed?.type !== "review" || !refreshed.payload.staleHeadReplacementWorkItemId) {
          throw new AppError({
            code: "agent_work.stale_head_marker_persist_failed",
            message: `Failed to persist stale-head replacement marker for work item ${item.id}`,
            context: { workItemId: item.id },
          });
        }
        replacementWorkItemId = refreshed.payload.staleHeadReplacementWorkItemId;
      } else {
        replacementWorkItemId = updateResult.rows[0].replacement_id;
      }
    }

    const nextPayload: ReviewWorkPayload = {
      ...payload,
      source: item.source,
      staleHeadRescheduled: true,
      staleHeadReplacementWorkItemId: replacementWorkItemId,
    };

    const insertResult = await client.query<{ head_sha: string }>(
      `INSERT INTO agent_work_items (
       id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
       head_sha, review_lens, resource_key, priority, payload
     )
     VALUES ($1, $2, 'review', $3, 'queued', $4, $5, $6, $7, $8, $9, $10, 0, $11::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload,
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
): Promise<void> {
  await client.query(
    `UPDATE agent_work_items
       SET payload = payload || '{"staleHeadReplacementEnqueued": true}'::jsonb,
           updated_at = now()
     WHERE id = $1`,
    [parentId],
  );
}

async function replacementReviewJobExists(boss: PgBoss, workItemId: string): Promise<boolean> {
  const jobs = await boss.findJobs<ReviewJobData>(REVIEW_QUEUE, { id: workItemId });
  return jobs.some((job) => {
    const state = job.state as string;
    return state !== "cancelled" && state !== "completed" && state !== "failed";
  });
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
): Promise<void> {
  const reviewLens = item.reviewLens;
  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};

  await inTransaction(pool, async (client) => {
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
    await markStaleHeadReplacementEnqueued(client, item.id);
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
