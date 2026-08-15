import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../../errors/appError.js";
import { pgBossDb } from "../../db/postgres.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../../settings/index.js";
import { uuidv5 } from "../../util/uuidv5.js";
import {
  installationGroupId,
  type AckJobData,
  type AskJobData,
  type CiRefreshJobData,
  type DescriptionJobData,
  type JobCorrelation,
  type PrRef,
  type ReviewJobData,
  type TriageJobData,
  type VerificationJobData,
  type WebhookHeaders,
} from "../types.js";

/** Deterministic pg-boss job id for one webhook delivery + PR (uuid column). */
export function ciRefreshBossJobId(webhookEventId: string, prNumber: number): string {
  return uuidv5(webhookEventId, `ci-refresh:${prNumber}`);
}

export function jobCorrelation(
  eventId: string,
  headers: Pick<WebhookHeaders, "delivery">,
): JobCorrelation {
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
    throw new AppError({
      code: "agent_work.enqueue_failed",
      message: `pg-boss did not enqueue ${queue} job`,
      context: { queue },
    });
  }
}

/**
 * Send a job with a deterministic id.
 * `null` from pg-boss means the job already exists — treat as success.
 */
async function sendBossJobIdempotent(
  boss: PgBoss,
  queue: string,
  data: object,
  options: Parameters<PgBoss["send"]>[2],
): Promise<"enqueued" | "already_present"> {
  const jobId = await boss.send(queue, data, options);
  return jobId == null ? "already_present" : "enqueued";
}

export async function enqueueAck(
  boss: PgBoss,
  client: PoolClient,
  data: AckJobData,
): Promise<void> {
  await requireBossJobSend(boss, ACK_QUEUE, data, {
    db: pgBossDb(client),
    priority: 100,
    group: { id: installationGroupId(data.installationId) },
  });
}

/**
 * Idempotent ack for ask promotion: same webhook event reuses one pg-boss job id.
 */
export async function enqueueAskAckIdempotent(
  boss: PgBoss,
  client: PoolClient,
  data: AckJobData,
  webhookEventId: string,
): Promise<"enqueued" | "already_present"> {
  return sendBossJobIdempotent(boss, ACK_QUEUE, data, {
    db: pgBossDb(client),
    id: webhookEventId,
    priority: 100,
    group: { id: installationGroupId(data.installationId) },
  });
}

export async function enqueueReview(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<void> {
  const data: ReviewJobData = { kind: "review", workItemId, ...correlation };
  await requireBossJobSend(boss, REVIEW_QUEUE, data, {
    db: pgBossDb(client),
    group: { id: installationGroupId(ref.installationId) },
  });
}

export async function enqueueAsk(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<"enqueued" | "already_present"> {
  const data: AskJobData = { kind: "ask", workItemId, ...correlation };
  return sendBossJobIdempotent(boss, ASK_QUEUE, data, {
    db: pgBossDb(client),
    id: workItemId,
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
  const data: DescriptionJobData = {
    kind: "description",
    workItemId,
    ...correlation,
  };
  await requireBossJobSend(boss, DESCRIPTION_QUEUE, data, {
    db: pgBossDb(client),
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
  const data: TriageJobData = {
    kind: "triage",
    workItemId,
    ...correlation,
  };
  await requireBossJobSend(boss, TRIAGE_QUEUE, data, {
    db: pgBossDb(client),
    group: { id: installationGroupId(ref.installationId) },
  });
}

export async function enqueueVerification(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
): Promise<void> {
  const data: VerificationJobData = {
    kind: "verification",
    workItemId,
    ...correlation,
  };
  await requireBossJobSend(boss, VERIFICATION_QUEUE, data, {
    db: pgBossDb(client),
    group: { id: installationGroupId(ref.installationId) },
  });
}

/** Idempotent CI refresh: one job per webhook delivery + PR. */
export async function enqueueCiRefreshIdempotent(
  boss: PgBoss,
  client: PoolClient,
  data: CiRefreshJobData,
  webhookEventId: string,
): Promise<"enqueued" | "already_present"> {
  return sendBossJobIdempotent(boss, CI_REFRESH_QUEUE, data, {
    db: pgBossDb(client),
    id: ciRefreshBossJobId(webhookEventId, data.prNumber),
    priority: 40,
    group: { id: installationGroupId(data.installationId) },
  });
}
