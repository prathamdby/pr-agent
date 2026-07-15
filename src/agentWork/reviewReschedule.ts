import crypto from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logInfo, logWarn } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { ACK_QUEUE, REVIEW_QUEUE } from "../settings/index.js";
import { getPullRequestHeadSha } from "./githubPrSurface.js";
import { getWorkItem, markQueuedWorkCancelled } from "./repository.js";
import { releaseReviewSingletonSlot } from "./singletonQueue.js";
import {
  installationGroupId,
  reviewSingletonKey,
  type ReviewWorkItem,
  type AckJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
} from "./types.js";

export type StaleSlashReviewRescheduleResult = {
  readonly rescheduled: true;
  readonly replacementWorkItemId: string;
  readonly afterComplete: (boss: PgBoss, activePgBossJobId: string) => Promise<void>;
  /** Cancel a persisted-but-not-enqueued replacement when the parent fails terminally. */
  readonly onRescheduleAbort: (error: unknown) => Promise<void>;
};

type SlashReviewRescheduleWorkItem = {
  readonly replacementWorkItemId: string;
  readonly headSha: string;
};

/**
 * Cancel a queued stale-head replacement that was persisted but never enqueued.
 * Uses the known replacement id from the reschedule result — no payload re-fetch/re-parse.
 * No-ops when enqueue already succeeded (`replacementEnqueued`).
 */
export async function cancelUnenqueuedStaleHeadReplacement(
  pool: Pool,
  parentWorkItemId: string,
  replacementWorkItemId: string,
  error: unknown,
  replacementEnqueued: boolean,
): Promise<void> {
  if (replacementEnqueued) return;
  try {
    if (!(await markQueuedWorkCancelled(pool, replacementWorkItemId, error))) {
      logWarn("agent_work_replacement_cancel_failed", {
        type: "review",
        workItemId: parentWorkItemId,
        replacementWorkItemId,
      });
    }
  } catch (cancelError) {
    logWarn("agent_work_replacement_cancel_failed", {
      type: "review",
      workItemId: parentWorkItemId,
      replacementWorkItemId,
      message: sanitizeLogMessage(
        cancelError instanceof Error ? cancelError.message : String(cancelError),
      ),
    });
  }
}

export async function buildStaleSlashReviewRescheduleResult(
  pool: Pool,
  item: ReviewWorkItem,
  token: string,
  expiresAtTs?: number,
): Promise<StaleSlashReviewRescheduleResult> {
  const latestHeadSha = await getPullRequestHeadSha(
    token,
    item.owner,
    item.repo,
    item.prNumber,
    expiresAtTs,
  );
  const replacement = await createSlashReviewRescheduleWorkItem(pool, item, latestHeadSha);
  // Closed over by afterComplete / onRescheduleAbort so terminal abort does not re-read payload.
  let replacementEnqueued = item.payload.staleHeadReplacementEnqueued === true;
  return {
    rescheduled: true,
    replacementWorkItemId: replacement.replacementWorkItemId,
    afterComplete: async (boss, activePgBossJobId) => {
      await enqueueSlashReviewReschedule(
        pool,
        boss,
        item,
        replacement.replacementWorkItemId,
        replacement.headSha,
        activePgBossJobId,
      );
      // enqueue either succeeded or was already marked; either way the replacement is live.
      replacementEnqueued = true;
    },
    onRescheduleAbort: async (error) => {
      await cancelUnenqueuedStaleHeadReplacement(
        pool,
        item.id,
        replacement.replacementWorkItemId,
        error,
        replacementEnqueued,
      );
    },
  };
}

export async function createSlashReviewRescheduleWorkItem(
  pool: Pool,
  item: ReviewWorkItem,
  latestHeadSha: string,
): Promise<SlashReviewRescheduleWorkItem> {
  const payload = item.payload;
  const reviewLens = item.reviewLens;
  let replacementWorkItemId = payload.staleHeadReplacementWorkItemId;

  if (!replacementWorkItemId) {
    replacementWorkItemId = crypto.randomUUID();
    const marker = JSON.stringify({
      staleHeadReplacementWorkItemId: replacementWorkItemId,
    });
    const updateResult = await pool.query<{ replacement_id: string }>(
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
        throw new Error(`Failed to persist stale-head replacement marker for work item ${item.id}`);
      }
      replacementWorkItemId = refreshed.payload.staleHeadReplacementWorkItemId;
    } else {
      replacementWorkItemId = updateResult.rows[0].replacement_id;
    }
  }

  const nextPayload: ReviewWorkPayload = {
    ...payload,
    staleHeadRescheduled: true,
    staleHeadReplacementWorkItemId: replacementWorkItemId,
  };

  const insertResult = await pool.query<{ head_sha: string }>(
    `INSERT INTO agent_work_items (
       id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
       head_sha, review_lens, resource_key, priority, payload
     )
     VALUES ($1, $2, 'review', 'slash', 'queued', $3, $4, $5, $6, $7, $8, $9, 0, $10::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload,
       updated_at = now()
     RETURNING head_sha`,
    [
      replacementWorkItemId,
      item.webhookEventId,
      item.owner,
      item.repo,
      item.prNumber,
      item.installationId,
      latestHeadSha,
      reviewLens,
      item.resourceKey,
      JSON.stringify(nextPayload),
    ],
  );

  return {
    replacementWorkItemId,
    headSha: insertResult.rows[0].head_sha,
  };
}

async function claimStaleHeadReplacementEnqueue(pool: Pool, parentId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
       SET payload = payload || '{"staleHeadReplacementEnqueued": true}'::jsonb,
           updated_at = now()
     WHERE id = $1
       AND (payload->>'staleHeadReplacementEnqueued') IS NULL`,
    [parentId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function releaseStaleHeadReplacementEnqueueClaim(
  pool: Pool,
  parentId: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_work_items
       SET payload = payload - 'staleHeadReplacementEnqueued',
           updated_at = now()
     WHERE id = $1`,
    [parentId],
  );
}

export async function enqueueSlashReviewReschedule(
  pool: Pool,
  boss: PgBoss,
  item: ReviewWorkItem,
  workItemId: string,
  replacementHeadSha: string,
  activePgBossJobId?: string,
): Promise<void> {
  const reviewLens = item.reviewLens;
  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};
  const parentPayload = item.payload;

  if (parentPayload.staleHeadReplacementEnqueued) {
    logInfo("review_stale_head_reschedule_enqueue_skipped", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      reviewLens,
      previousWorkItemId: item.id,
      replacementWorkItemId: workItemId,
    });
    return;
  }

  const claimed = await claimStaleHeadReplacementEnqueue(pool, item.id);
  if (!claimed) {
    const refreshed = await getWorkItem(pool, item.id);
    if (refreshed?.type === "review" && refreshed.payload.staleHeadReplacementEnqueued) {
      logInfo("review_stale_head_reschedule_enqueue_skipped", {
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
        reviewLens,
        previousWorkItemId: item.id,
        replacementWorkItemId: workItemId,
      });
      return;
    }
    throw new Error(`Failed to claim stale-head replacement enqueue for work item ${item.id}`);
  }

  try {
    await releaseReviewSingletonSlot(boss, item.resourceKey, reviewLens, {
      skipJobId: activePgBossJobId,
    });

    const reviewData: ReviewJobData = {
      kind: "review",
      workItemId,
      ...correlation,
    };
    const reviewJobId = await boss.send(REVIEW_QUEUE, reviewData, {
      singletonKey: reviewSingletonKey(item.resourceKey, reviewLens),
      group: { id: installationGroupId(item.installationId) },
    });
    if (reviewJobId == null) {
      throw new Error("pg-boss did not enqueue replacement review job");
    }

    const ackData: AckJobData = {
      kind: "ack",
      workItemId,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      targets: [],
      progress: { lens: reviewLens, headSha: replacementHeadSha, source: "slash" },
      ...correlation,
    };
    const ackJobId = await boss.send(ACK_QUEUE, ackData, {
      priority: 100,
      group: { id: installationGroupId(item.installationId) },
    });
    if (ackJobId == null) {
      throw new Error("pg-boss did not enqueue replacement review ack job");
    }

    logInfo("review_stale_head_rescheduled", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      reviewLens,
      previousWorkItemId: item.id,
      replacementWorkItemId: workItemId,
      previousHeadSha: item.headSha,
      latestHeadSha: replacementHeadSha,
    });
  } catch (e) {
    await releaseStaleHeadReplacementEnqueueClaim(pool, item.id);
    throw e;
  }
}
