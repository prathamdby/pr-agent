import crypto from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logInfo } from "../evlog.js";
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

export async function scheduleSlashReviewReschedule(
  pool: Pool,
  boss: PgBoss,
  item: AgentWorkItem,
  latestHeadSha: string,
): Promise<string> {
  const payload = item.payload as ReviewWorkPayload;
  const reviewLens = item.reviewLens!;
  const workItemId = crypto.randomUUID();
  const nextPayload: ReviewWorkPayload = {
    ...payload,
    staleHeadRescheduled: true,
  };

  await pool.query(
    `INSERT INTO agent_work_items (
       id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
       head_sha, review_lens, resource_key, priority, payload
     )
     VALUES ($1, $2, 'review', 'slash', 'queued', $3, $4, $5, $6, $7, $8, $9, 0, $10::jsonb)`,
    [
      workItemId,
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

  const correlation = item.webhookEventId ? { webhookEventId: item.webhookEventId } : {};
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

  return workItemId;
}
