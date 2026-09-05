import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../../errors/appError.js";
import { pgBossDb } from "../../db/postgres.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_QUEUE,
  CI_REFRESH_RETRY_ATTEMPT_LIMIT,
  CI_REFRESH_RETRY_DELAY_SECONDS,
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

/** Deterministic pg-boss id for one delivery + PR + attempt. */
export function ciRefreshJobId(webhookEventId: string, prNumber: number, attempt: number): string {
  return uuidv5(webhookEventId, `ci-refresh:${prNumber}:${attempt}`);
}

/** One pending job per PR head and attempt. Later same-head sends join that slot. */
export function ciRefreshSingletonKey(
  data: Pick<CiRefreshJobData, "owner" | "repo" | "prNumber" | "headSha" | "attempt">,
): string {
  return `${data.owner}/${data.repo}#${data.prNumber}:${data.headSha}:${data.attempt}`;
}

/** Next retain hop, or null when the cap is exhausted. */
export function nextCiRefreshAttempt(attempt: number): number | null {
  if (attempt >= CI_REFRESH_RETRY_ATTEMPT_LIMIT) return null;
  return attempt + 1;
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

async function enqueueLeasedWork(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  queue: string,
  data: object,
): Promise<void> {
  await requireBossJobSend(boss, queue, data, {
    db: pgBossDb(client),
    group: { id: installationGroupId(ref.installationId) },
  });
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
  await enqueueLeasedWork(boss, client, ref, REVIEW_QUEUE, data);
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
  await enqueueLeasedWork(boss, client, ref, DESCRIPTION_QUEUE, data);
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
  await enqueueLeasedWork(boss, client, ref, TRIAGE_QUEUE, data);
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
  await enqueueLeasedWork(boss, client, ref, VERIFICATION_QUEUE, data);
}

function ciRefreshSendOptions(
  data: CiRefreshJobData,
  extra: Pick<NonNullable<Parameters<PgBoss["send"]>[2]>, "db" | "startAfter">,
): NonNullable<Parameters<PgBoss["send"]>[2]> {
  const options: NonNullable<Parameters<PgBoss["send"]>[2]> = {
    ...extra,
    singletonKey: ciRefreshSingletonKey(data),
    singletonSeconds: CI_REFRESH_RETRY_DELAY_SECONDS,
    priority: 40,
    group: { id: installationGroupId(data.installationId) },
  };
  if (data.webhookEventId) {
    options.id = ciRefreshJobId(data.webhookEventId, data.prNumber, data.attempt);
  }
  return options;
}

/** Idempotent CI refresh: one job per webhook delivery + PR + attempt. */
export async function enqueueCiRefreshIdempotent(
  boss: PgBoss,
  client: PoolClient,
  data: CiRefreshJobData,
  webhookEventId: string,
): Promise<"enqueued" | "already_present"> {
  return sendBossJobIdempotent(
    boss,
    CI_REFRESH_QUEUE,
    data,
    ciRefreshSendOptions({ ...data, webhookEventId }, { db: pgBossDb(client) }),
  );
}

/** Delayed retain hop after an active review. Same send options as intake. */
export async function enqueueCiRefreshRetry(
  boss: PgBoss,
  data: CiRefreshJobData,
): Promise<"enqueued" | "already_present"> {
  return sendBossJobIdempotent(
    boss,
    CI_REFRESH_QUEUE,
    data,
    ciRefreshSendOptions(data, { startAfter: CI_REFRESH_RETRY_DELAY_SECONDS }),
  );
}
