import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { applyCiRefreshIntake } from "../../src/agentWork/intake/applier.js";
import { ciRefreshBossJobId } from "../../src/agentWork/intake/queueing.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import type { QueueConfig, WebhookHeaders } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOperationLogger } from "../../src/evlog.js";
import {
  CI_REFRESH_QUEUE,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
} from "../../src/settings/index.js";
import { hasDatabase, integrationPool, requireDatabaseUrl } from "./db.js";

const OWNER = "ci-refresh-it";
const EVENT = "workflow_run";
const DATABASE_URL = requireDatabaseUrl();

const queueConfig: QueueConfig = {
  queueRetryLimit: DEFAULT_QUEUE_RETRY_LIMIT,
  queueRetryDelaySeconds: DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  queueRetryDelayMaxSeconds: DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  queueExpireInSeconds: DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  queueHeartbeatSeconds: DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  queuePollingIntervalSeconds: DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  queueRetentionSeconds: DEFAULT_QUEUE_RETENTION_SECONDS,
  queueDeleteAfterSeconds: DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  installationGroupConcurrency: DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
};

function headers(delivery: string): WebhookHeaders {
  return {
    event: EVENT,
    delivery,
    rawBody: Buffer.from(JSON.stringify({ action: "completed", delivery })),
  };
}

function intakeLog() {
  return createOperationLogger({ method: "POST", path: "/webhooks" });
}

async function deleteCiRefreshJobs(boss: PgBoss): Promise<void> {
  const jobs = await boss.findJobs(CI_REFRESH_QUEUE, {});
  if (jobs.length > 0) {
    await boss.deleteJob(
      CI_REFRESH_QUEUE,
      jobs.map((job) => job.id),
    );
  }
}

describe.skipIf(!hasDatabase)("CI-refresh enqueue against real pg-boss (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteCiRefreshJobs(boss);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await deleteCiRefreshJobs(boss);
  });

  it("enqueues a uuid job id and commits the webhook dedupe row", async () => {
    const delivery = `ci-refresh-${randomUUID().slice(0, 8)}`;
    const prNumber = 42;
    const headSha = "abc123def456";

    await applyCiRefreshIntake(
      boss,
      pool,
      headers(delivery),
      {
        installationId: 9001,
        owner: OWNER,
        repo: "app",
        headSha,
        prNumbers: [prNumber],
      },
      intakeLog(),
    );

    const { rows: events } = await pool.query<{ id: string }>(
      "SELECT id FROM webhook_events WHERE event_name = $1 AND delivery_id = $2",
      [EVENT, delivery],
    );
    expect(events).toHaveLength(1);
    const webhookEventId = events[0].id;

    const jobs = await boss.findJobs(CI_REFRESH_QUEUE, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(ciRefreshBossJobId(webhookEventId, prNumber));
    expect(jobs[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(jobs[0].data).toMatchObject({
      kind: "ci_refresh",
      owner: OWNER,
      repo: "app",
      prNumber,
      headSha,
      webhookEventId,
    });
  });

  it("treats a second enqueue of the same delivery+PR as already_present", async () => {
    const delivery = `ci-refresh-idem-${randomUUID().slice(0, 8)}`;
    const data = {
      installationId: 9001,
      owner: OWNER,
      repo: "app",
      headSha: "deadbeef",
      prNumbers: [7],
    };

    await applyCiRefreshIntake(boss, pool, headers(delivery), data, intakeLog());
    const firstJobs = await boss.findJobs(CI_REFRESH_QUEUE, {});
    expect(firstJobs).toHaveLength(1);

    // Same delivery is deduped at webhook_events before enqueue — use a fresh
    // delivery that reuses the same deterministic job id via direct enqueue
    // is covered by apply path: duplicate delivery must not abort the transaction.
    await applyCiRefreshIntake(boss, pool, headers(delivery), data, intakeLog());

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM webhook_events WHERE delivery_id = $1",
      [delivery],
    );
    expect(Number(rows[0]?.count ?? "0")).toBe(1);
    await expect(boss.findJobs(CI_REFRESH_QUEUE, {})).resolves.toHaveLength(1);
  });
});
