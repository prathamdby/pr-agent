import crypto from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { ReviewMode } from "../agent/reviewSchema.js";
import { logInfo } from "../evlog.js";
import { getWorkItem } from "./repository.js";
import {
  ACK_QUEUE,
  REVIEW_QUEUE,
  installationGroupId,
  reviewSingletonKey,
  type AgentWorkItem,
  type AckJobData,
  type ReviewJobData,
  type ReviewWorkPayload,
} from "./types.js";

export async function releaseReviewSingletonSlot(
  boss: PgBoss,
  resourceKey: string,
  lens: ReviewMode,
  opts?: { skipJobId?: string },
): Promise<void> {
  const key = reviewSingletonKey(resourceKey, lens);
  const jobs = await boss.findJobs(REVIEW_QUEUE, { key });
  for (const job of jobs) {
    if (opts?.skipJobId && job.id === opts.skipJobId) continue;
    const state = job.state as string;
    if (state === "cancelled" || state === "completed" || state === "failed") continue;
    await boss.cancel(REVIEW_QUEUE, job.id);
  }
}

export async function createSlashReviewRescheduleWorkItem(
  pool: Pool,
  item: AgentWorkItem,
  latestHeadSha: string,
): Promise<string> {
  const payload = item.payload as ReviewWorkPayload;
  const reviewLens = item.reviewLens!;
  let replacementWorkItemId = payload.staleHeadReplacementWorkItemId;

  if (!replacementWorkItemId) {
    replacementWorkItemId = crypto.randomUUID();
    const marker = JSON.stringify({ staleHeadReplacementWorkItemId: replacementWorkItemId });
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

  await pool.query(
    `INSERT INTO agent_work_items (
       id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
       head_sha, review_lens, resource_key, priority, payload
     )
     VALUES ($1, $2, 'review', 'slash', 'queued', $3, $4, $5, $6, $7, $8, $9, 0, $10::jsonb)
     ON CONFLICT (id) DO NOTHING`,
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

  return replacementWorkItemId;
}

export async function enqueueSlashReviewReschedule(
  boss: PgBoss,
  item: AgentWorkItem,
  workItemId: string,
  latestHeadSha: string,
  activePgBossJobId?: string,
): Promise<void> {
  const reviewLens = item.reviewLens!;
  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};

  await releaseReviewSingletonSlot(boss, item.resourceKey, reviewLens, {
    skipJobId: activePgBossJobId,
  });

  const ackData: AckJobData = {
    kind: "ack",
    workItemId,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    targets: [],
    progress: { lens: reviewLens, headSha: latestHeadSha, source: "slash" },
    ...correlation,
  };
  const ackJobId = await boss.send(ACK_QUEUE, ackData, {
    priority: 100,
    group: { id: installationGroupId(item.installationId) },
  });
  if (ackJobId == null) {
    throw new Error("pg-boss did not enqueue replacement review ack job");
  }

  const reviewData: ReviewJobData = { kind: "review", workItemId, ...correlation };
  const reviewJobId = await boss.send(REVIEW_QUEUE, reviewData, {
    singletonKey: reviewSingletonKey(item.resourceKey, reviewLens),
    group: { id: installationGroupId(item.installationId) },
  });
  if (reviewJobId == null) {
    throw new Error("pg-boss did not enqueue replacement review job");
  }

  logInfo("review_stale_head_rescheduled", {
    owner: item.owner,
    repo: item.repo,
    pr: item.prNumber,
    reviewLens,
    previousWorkItemId: item.id,
    replacementWorkItemId: workItemId,
    previousHeadSha: item.headSha,
    latestHeadSha,
  });
}

export async function scheduleSlashReviewReschedule(
  pool: Pool,
  boss: PgBoss,
  item: AgentWorkItem,
  latestHeadSha: string,
): Promise<string> {
  const workItemId = await createSlashReviewRescheduleWorkItem(pool, item, latestHeadSha);
  await enqueueSlashReviewReschedule(boss, item, workItemId, latestHeadSha);
  return workItemId;
}
