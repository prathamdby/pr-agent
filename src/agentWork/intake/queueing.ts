import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { ReviewMode } from "../../review/reviewSchema.js";
import { pgBossDb } from "../../db/postgres.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
} from "../../settings.js";
import {
  descriptionSingletonKey,
  installationGroupId,
  prResourceKey,
  reviewSingletonKey,
  triageSingletonKey,
  type AckJobData,
  type AskJobData,
  type DescriptionJobData,
  type JobCorrelation,
  type PrRef,
  type ReviewJobData,
  type TriageJobData,
  type WebhookHeaders,
} from "../types.js";

export function jobCorrelation(eventId: string, headers: WebhookHeaders): JobCorrelation {
  return {
    webhookEventId: eventId,
    delivery: headers.delivery,
  };
}

async function requireBossJobSend(
  boss: PgBoss,
  queue: string,
  data: object,
  options: Parameters<PgBoss["send"]>[2],
): Promise<void> {
  const jobId = await boss.send(queue, data, options);
  if (jobId == null) {
    throw new Error(`pg-boss did not enqueue ${queue} job`);
  }
}

export async function enqueueAck(
  boss: PgBoss,
  client: PoolClient,
  data: AckJobData,
  priority = 100,
): Promise<void> {
  await requireBossJobSend(boss, ACK_QUEUE, data, {
    db: pgBossDb(client),
    priority,
    group: { id: installationGroupId(data.installationId) },
  });
}

export async function enqueueReview(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  lens: ReviewMode,
  correlation: JobCorrelation,
): Promise<void> {
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const data: ReviewJobData = { kind: "review", workItemId, ...correlation };
  await requireBossJobSend(boss, REVIEW_QUEUE, data, {
    db: pgBossDb(client),
    singletonKey: reviewSingletonKey(resourceKey, lens),
    group: { id: installationGroupId(ref.installationId) },
  });
}

export async function enqueueAsk(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<void> {
  const data: AskJobData = { kind: "ask", workItemId, ...correlation };
  await requireBossJobSend(boss, ASK_QUEUE, data, {
    db: pgBossDb(client),
    priority: 50,
    group: { id: installationGroupId(ref.installationId) },
  });
}

export async function enqueueDescription(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<void> {
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const data: DescriptionJobData = {
    kind: "description",
    workItemId,
    ...correlation,
  };
  await requireBossJobSend(boss, DESCRIPTION_QUEUE, data, {
    db: pgBossDb(client),
    singletonKey: descriptionSingletonKey(resourceKey),
    group: { id: installationGroupId(ref.installationId) },
  });
}

export async function enqueueTriage(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<void> {
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const data: TriageJobData = {
    kind: "triage",
    workItemId,
    ...correlation,
  };
  await requireBossJobSend(boss, TRIAGE_QUEUE, data, {
    db: pgBossDb(client),
    singletonKey: triageSingletonKey(resourceKey),
    group: { id: installationGroupId(ref.installationId) },
  });
}
