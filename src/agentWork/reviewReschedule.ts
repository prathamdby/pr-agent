import crypto from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logInfo } from "../evlog.js";
import { ACK_QUEUE, REVIEW_QUEUE } from "../settings.js";
import { getPullRequestHead } from "./githubPrSurface.js";
import { getWorkItem } from "./repository.js";
import { releaseReviewSingletonSlot } from "./singletonQueue.js";
import {
  installationGroupId,
  reviewSingletonKey,
  type AgentWorkItem,
  type AckJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
} from "./types.js";

export type StaleSlashReviewRescheduleResult = {
  readonly rescheduled: true;
  readonly replacementWorkItemId: string;
  readonly afterComplete: (boss: PgBoss, activePgBossJobId: string) => Promise<void>;
};

type SlashReviewRescheduleWorkItem = {
  readonly replacementWorkItemId: string;
  readonly headSha: string;
};

export async function buildStaleSlashReviewRescheduleResult(
  pool: Pool,
  item: AgentWorkItem,
  token: string,
  expiresAtTs?: number,
): Promise<StaleSlashReviewRescheduleResult> {
  const latestHeadSha = (
    await getPullRequestHead(token, item.owner, item.repo, item.prNumber, expiresAtTs)
  ).headSha;
  const replacement = await createSlashReviewRescheduleWorkItem(pool, item, latestHeadSha);
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
    },
  };
}

export async function createSlashReviewRescheduleWorkItem(
  pool: Pool,
  item: AgentWorkItem,
  latestHeadSha: string,
): Promise<SlashReviewRescheduleWorkItem> {
  const payload = item.payload as ReviewWorkPayload;
  const reviewLens = item.reviewLens!;
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
      replacementWorkItemId = (refreshed?.payload as ReviewWorkPayload)
        ?.staleHeadReplacementWorkItemId;
      if (!replacementWorkItemId) {
        throw new Error(`Failed to persist stale-head replacement marker for work item ${item.id}`);
      }
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
  item: AgentWorkItem,
  workItemId: string,
  replacementHeadSha: string,
  activePgBossJobId?: string,
): Promise<void> {
  const reviewLens = item.reviewLens!;
  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};
  const parentPayload = item.payload as ReviewWorkPayload;

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
    if ((refreshed?.payload as ReviewWorkPayload)?.staleHeadReplacementEnqueued) {
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
