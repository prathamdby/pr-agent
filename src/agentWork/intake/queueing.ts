import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../../errors/appError.js";
import { pgBossDb } from "../../db/postgres.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../../settings/index.js";
import {
  installationGroupId,
  type AckJobData,
  type AskJobData,
  type CiProjectionJobData,
  type DescriptionJobData,
  type JobCorrelation,
  type PrRef,
  type ReviewJobData,
  type TriageJobData,
  type VerificationJobData,
  type WebhookHeaders,
} from "../types.js";

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

const CI_PROJECTION_DEBOUNCE_SECONDS = 5;

type CiProjectionPayload = CiProjectionJobData & {
  readonly correlations?: readonly JobCorrelation[];
};

function ciProjectionCorrelations(data: CiProjectionPayload): JobCorrelation[] {
  const correlations = new Map<string, JobCorrelation>();
  for (const identity of [...(data.correlations ?? []), data]) {
    const correlation: JobCorrelation = {
      ...(identity.webhookEventId ? { webhookEventId: identity.webhookEventId } : {}),
      ...(identity.delivery ? { delivery: identity.delivery } : {}),
    };
    if (Object.keys(correlation).length > 0) {
      correlations.set(JSON.stringify(correlation), correlation);
    }
  }
  return [...correlations.values()];
}

async function mergeCiProjectionCorrelations(
  client: PoolClient,
  data: CiProjectionJobData,
  singletonKey: string,
  correlations: readonly JobCorrelation[],
): Promise<void> {
  // pg-boss tries the current slot, then the next. Its throttle index includes
  // active and terminal rows; append against the locked row, not a stale read.
  const { rows } = await client.query<{ id: string }>(
    `UPDATE pgboss.job
        SET data = jsonb_set(data, '{correlations}', (
          SELECT jsonb_agg(DISTINCT correlation)
            FROM jsonb_array_elements(
              COALESCE(data->'correlations', '[]'::jsonb)
              || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'webhookEventId', NULLIF(data->>'webhookEventId', ''),
                'delivery', NULLIF(data->>'delivery', '')
              )))
              || $8::jsonb
            ) AS identities(correlation)
           WHERE correlation <> '{}'::jsonb
        ))
      WHERE name = $1
        AND singleton_key = $2
        AND singleton_on = 'epoch'::timestamp + '1s'::interval
          * ($3::float8 * floor((date_part('epoch', now()) + $3::float8) / $3::float8))
        AND state <> 'cancelled'
        AND data->>'owner' = $4
        AND data->>'repo' = $5
        AND data->>'headSha' = $6
        AND data->>'installationId' = $7::text
      RETURNING id`,
    [
      CI_PROJECTION_QUEUE,
      singletonKey,
      CI_PROJECTION_DEBOUNCE_SECONDS,
      data.owner,
      data.repo,
      data.headSha,
      data.installationId,
      JSON.stringify(correlations),
    ],
  );
  if (rows.length !== 1) {
    throw new AppError({
      code: "agent_work.ci_projection_correlation_missing",
      message: "CI projection correlation target is missing",
      context: {
        queue: CI_PROJECTION_QUEUE,
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
      },
    });
  }
}

/** Later writes join the next 5s slot and retain their intake identities. */
export async function enqueueCiProjectionDebounced(
  boss: PgBoss,
  client: PoolClient,
  data: CiProjectionJobData,
): Promise<"enqueued" | "already_present"> {
  const correlations = ciProjectionCorrelations(data);
  const payload = correlations.length > 0 ? { ...data, correlations } : data;
  const singletonKey = `${data.owner}/${data.repo}:${data.headSha}`;
  const jobId = await boss.sendDebounced(
    CI_PROJECTION_QUEUE,
    payload,
    {
      db: pgBossDb(client),
      priority: 40,
      group: { id: installationGroupId(data.installationId) },
    },
    CI_PROJECTION_DEBOUNCE_SECONDS,
    singletonKey,
  );
  if (jobId != null) return "enqueued";
  if (correlations.length > 0) {
    await mergeCiProjectionCorrelations(client, data, singletonKey, correlations);
  }
  return "already_present";
}

/** Same debounce as intake, without a transaction client. Used by the projector and writers. */
export async function enqueueCiProjectionDebouncedStandalone(
  boss: PgBoss,
  data: CiProjectionJobData,
): Promise<"enqueued" | "already_present"> {
  const jobId = await boss.sendDebounced(
    CI_PROJECTION_QUEUE,
    data,
    {
      priority: 40,
      group: { id: installationGroupId(data.installationId) },
    },
    CI_PROJECTION_DEBOUNCE_SECONDS,
    `${data.owner}/${data.repo}:${data.headSha}`,
  );
  return jobId == null ? "already_present" : "enqueued";
}

/** Defer one projection until the shared rate-limit circuit closes. */
export async function enqueueCiProjectionAfter(
  boss: PgBoss,
  data: CiProjectionJobData,
  startAfterSeconds: number,
): Promise<"enqueued" | "already_present"> {
  return sendBossJobIdempotent(boss, CI_PROJECTION_QUEUE, data, {
    startAfter: Math.max(1, startAfterSeconds),
    singletonKey: `${data.owner}/${data.repo}:${data.headSha}:deferred`,
    singletonSeconds: Math.max(1, startAfterSeconds),
    priority: 40,
    group: { id: installationGroupId(data.installationId) },
  });
}
