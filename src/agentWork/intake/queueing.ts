import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../../errors/appError.ts";
import { pgBossDb } from "../../db/postgres.ts";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../../settings/index.ts";
import {
  installationGroupId,
  type AckJobData,
  type AskJobData,
  type DescriptionJobData,
  type JobCorrelation,
  type PrRef,
  type ReviewJobData,
  type TriageJobData,
  type VerificationJobData,
  type WebhookHeaders,
} from "../types.ts";

export function jobCorrelation(eventId: string, headers: Pick<WebhookHeaders, "delivery">) {
  return ((pinnedReturn: JobCorrelation) => pinnedReturn)({
    webhookEventId: eventId,
    delivery: headers.delivery,
  });
}

async function requireBossJobSend(
  boss: PgBoss,
  queue: string,
  data: object,
  options: Parameters<PgBoss["send"]>[2],
) {
  const jobId = await boss.send(queue, data, options);
  if (jobId == null) {
    throw new AppError({
      domain: "agent_work",
      kind: "enqueue_failed",
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
) {
  await requireBossJobSend(boss, queue, data, {
    db: pgBossDb(client),
    group: { id: installationGroupId(ref.installationId) },
  });
}

async function sendBossJobIdempotent(
  boss: PgBoss,
  queue: string,
  data: object,
  options: Parameters<PgBoss["send"]>[2],
) {
  const jobId = await boss.send(queue, data, options);
  return ((
    pinnedReturn: ("enqueued" | "already_present") | Promise<"enqueued" | "already_present">,
  ) => pinnedReturn)(jobId == null ? "already_present" : "enqueued");
}

export async function enqueueAck(boss: PgBoss, client: PoolClient, data: AckJobData) {
  await requireBossJobSend(boss, ACK_QUEUE, data, {
    db: pgBossDb(client),
    priority: 100,
    group: { id: installationGroupId(data.installationId) },
  });
}

export async function enqueueAskAckIdempotent(
  boss: PgBoss,
  client: PoolClient,
  data: AckJobData,
  webhookEventId: string,
) {
  return ((
    pinnedReturn: ("enqueued" | "already_present") | Promise<"enqueued" | "already_present">,
  ) => pinnedReturn)(
    sendBossJobIdempotent(boss, ACK_QUEUE, data, {
      db: pgBossDb(client),
      id: webhookEventId,
      priority: 100,
      group: { id: installationGroupId(data.installationId) },
    }),
  );
}

export async function enqueueReview(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
) {
  const data: ReviewJobData = { kind: "review", workItemId, ...correlation };
  await enqueueLeasedWork(boss, client, ref, REVIEW_QUEUE, data);
}

export async function enqueueAsk(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
) {
  const data: AskJobData = { kind: "ask", workItemId, ...correlation };
  return ((
    pinnedReturn: ("enqueued" | "already_present") | Promise<"enqueued" | "already_present">,
  ) => pinnedReturn)(
    sendBossJobIdempotent(boss, ASK_QUEUE, data, {
      db: pgBossDb(client),
      id: workItemId,
      priority: 50,
      group: { id: installationGroupId(ref.installationId) },
    }),
  );
}

export async function enqueueDescription(
  boss: PgBoss,
  client: PoolClient,
  ref: PrRef,
  workItemId: string,
  correlation: JobCorrelation,
) {
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
) {
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
) {
  const data: VerificationJobData = {
    kind: "verification",
    workItemId,
    ...correlation,
  };
  await enqueueLeasedWork(boss, client, ref, VERIFICATION_QUEUE, data);
}
