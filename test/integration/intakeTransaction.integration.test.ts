import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss, SendOptions } from "pg-boss";
import { applyAutomatedPullRequestIntake } from "../../src/agentWork/intake/applier.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import type { PrRef, QueueConfig, WebhookHeaders } from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOperationLogger } from "../../src/evlog.js";
import { makeTestConfig } from "../helpers/config.js";

// These tests exercise the supersede/cancel mechanism on repeated synchronize deliveries,
// which only auto-runs review on push when the review trigger includes synchronize.
// Verification stays off so work-item counts only reflect review intake.
vi.mock("../../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/settings/index.js")>();
  return {
    ...actual,
    AUTO_TRIGGER_ACTIONS: {
      ...actual.AUTO_TRIGGER_ACTIONS,
      review: new Set(["opened", "synchronize"]),
    },
  };
});

const intakeCfg = makeTestConfig({
  features: { ...makeTestConfig().features, verification: "off" },
});
import {
  ACK_QUEUE,
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
  REVIEW_QUEUE,
} from "../../src/settings/index.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "intake-tx-it";
const EVENT = "intake-tx-it";
const DATABASE_URL = process.env.DATABASE_URL!;
const CLEANUP_QUEUES = [ACK_QUEUE, REVIEW_QUEUE] as const;

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

function headers(action: string, delivery: string): WebhookHeaders {
  return {
    event: EVENT,
    delivery,
    rawBody: Buffer.from(JSON.stringify({ action, delivery })),
  };
}

function makePrRef(suffix = ""): PrRef {
  const id = suffix || randomUUID().slice(0, 8);
  return {
    owner: OWNER,
    repo: `repo-${id}`,
    prNumber: 100 + id.charCodeAt(0),
    installationId: 9001,
    headSha: `sha-${id}`,
  };
}

function intakeLog() {
  return createOperationLogger({ method: "POST", path: "/webhooks" });
}

function withSendFailOnNth(realBoss: PgBoss, failOnSend: number): { restore: () => void } {
  let sendCount = 0;
  const originalSend = realBoss.send.bind(realBoss);
  realBoss.send = (async (name: string, data?: object | null, options?: SendOptions) => {
    sendCount += 1;
    if (sendCount >= failOnSend) {
      throw new Error("injected send failure");
    }
    return originalSend(name, data, options);
  }) as PgBoss["send"];
  return {
    restore: () => {
      realBoss.send = originalSend;
    },
  };
}

async function deleteQueueJobs(boss: PgBoss): Promise<void> {
  for (const queue of CLEANUP_QUEUES) {
    const jobs = await boss.findJobs(queue, {});
    if (jobs.length > 0) {
      await boss.deleteJob(
        queue,
        jobs.map((job) => job.id),
      );
    }
  }
}

describe.skipIf(!hasDatabase)("intake transaction (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteQueueJobs(boss);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await deleteQueueJobs(boss);
  });

  async function countWebhookRows(delivery?: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      delivery
        ? "SELECT COUNT(*)::text AS count FROM webhook_events WHERE event_name = $1 AND delivery_id = $2"
        : "SELECT COUNT(*)::text AS count FROM webhook_events WHERE event_name = $1",
      delivery ? [EVENT, delivery] : [EVENT],
    );
    return Number(rows[0]?.count ?? "0");
  }

  async function countWorkItems(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_work_items WHERE owner = $1",
      [OWNER],
    );
    return Number(rows[0]?.count ?? "0");
  }

  async function countReplayRows(rawBody: Buffer): Promise<number> {
    const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM webhook_event_replays WHERE body_sha256 = $1",
      [bodySha256],
    );
    return Number(rows[0]?.count ?? "0");
  }

  async function reviewJobsFor(ref: PrRef) {
    const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE resource_key = $1`,
      [key],
    );
    const workItemIds = new Set(rows.map((row) => row.id));
    const jobs = await boss.findJobs(REVIEW_QUEUE, {});
    return jobs.filter((job) =>
      workItemIds.has((job.data as { workItemId?: string }).workItemId ?? ""),
    );
  }

  it("happy path: one delivery commits webhook, work item, ack, and review jobs", async () => {
    const ref = makePrRef("happy");
    const delivery = "delivery-happy";

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", delivery),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    await expect(countWebhookRows(delivery)).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(1);

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const reviewJobs = await reviewJobsFor(ref);
    expect(ackJobs).toHaveLength(1);
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]?.state).toBe("created");
  });

  it("rollback atomicity: late send failure rolls back dedupe, work item, and jobs", async () => {
    const ref = makePrRef("rollback");
    const delivery = "delivery-rollback";
    const requestHeaders = headers("synchronize", delivery);
    const failingBoss = withSendFailOnNth(boss, 2);
    try {
      await expect(
        applyAutomatedPullRequestIntake(
          boss,
          pool,
          requestHeaders,
          ref,
          "synchronize",
          intakeLog(),
          intakeCfg,
        ),
      ).rejects.toThrow("injected send failure");
    } finally {
      failingBoss.restore();
    }

    await expect(countWebhookRows(delivery)).resolves.toBe(0);
    await expect(countReplayRows(requestHeaders.rawBody)).resolves.toBe(0);
    await expect(countWorkItems()).resolves.toBe(0);
    await expect(boss.findJobs(ACK_QUEUE, {})).resolves.toHaveLength(0);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(0);

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      requestHeaders,
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    await expect(countWebhookRows(delivery)).resolves.toBe(1);
    await expect(countReplayRows(requestHeaders.rawBody)).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(1);
    await expect(boss.findJobs(ACK_QUEUE, {})).resolves.toHaveLength(1);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(1);
  });

  it("dedupes the same body across delivery ids before creating more work", async () => {
    const ref = makePrRef("body-replay");
    const rawBody = Buffer.from(JSON.stringify({ action: "synchronize", replay: true }));

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      { ...headers("synchronize", "delivery-body-a"), rawBody },
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      { ...headers("synchronize", "delivery-body-b"), rawBody },
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    await expect(countWebhookRows()).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(1);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(1);
  });

  it("supersede flow: second delivery supersedes the work item and enqueues a fresh job", async () => {
    const ref = makePrRef("supersede");

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-supersede-a"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    const firstJobs = await reviewJobsFor(ref);
    const firstJobId = firstJobs[0]?.id;
    expect(firstJobId).toBeDefined();

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-supersede-b"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    const { rows: workRows } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_work_items WHERE owner = $1 ORDER BY created_at`,
      [OWNER],
    );
    expect(workRows.map((row) => row.status).toSorted()).toEqual(["queued", "superseded"]);

    // Intake no longer cancels the superseded delivery's pg-boss job: the stale
    // delivery no-ops at execution because its work item is terminal.
    const firstJob = firstJobId ? await boss.getJobById(REVIEW_QUEUE, firstJobId) : null;
    expect(firstJob?.state).toBe("created");

    const createdJobs = (await reviewJobsFor(ref)).filter((job) => job.state === "created");
    expect(createdJobs).toHaveLength(2);
    const { rows: queuedRows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE owner = $1 AND status = 'queued'`,
      [OWNER],
    );
    expect(queuedRows).toHaveLength(1);
    const liveJob = createdJobs.find(
      (job) => (job.data as { workItemId?: string }).workItemId === queuedRows[0]?.id,
    );
    expect(liveJob?.state).toBe("created");
  });

  it("failed prior job: next auto delivery enqueues a fresh runnable job", async () => {
    const ref = makePrRef("failed-block");

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-failed-a"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    const firstJobs = await reviewJobsFor(ref);
    const firstJobId = firstJobs[0]?.id;
    expect(firstJobId).toBeDefined();

    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      firstJobId,
    ]);
    await pool.query(
      `UPDATE agent_work_items SET status = 'failed', completed_at = now(), updated_at = now()
        WHERE owner = $1 AND status = 'queued'`,
      [OWNER],
    );

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-failed-b"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    // Terminal pg-boss rows are left in place; the lease, not queue state, decides who runs.
    const failedJob = await boss.getJobById(REVIEW_QUEUE, firstJobId);
    expect(failedJob?.state).toBe("failed");

    const { rows: queuedRows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE owner = $1 AND status = 'queued'`,
      [OWNER],
    );
    expect(queuedRows).toHaveLength(1);
    const liveJob = (await reviewJobsFor(ref)).find(
      (job) => (job.data as { workItemId?: string }).workItemId === queuedRows[0]?.id,
    );
    expect(liveJob?.state).toBe("created");
  });

  it("ignored-action flip: enqueue-first then ignored dedupes without extra work", async () => {
    const ref = makePrRef("flip-enq-first");
    const delivery = "delivery-flip-enq-first";

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", delivery),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("labeled", delivery),
      ref,
      "labeled",
      intakeLog(),
      intakeCfg,
    );

    await expect(countWebhookRows(delivery)).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(1);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(1);
  });

  it("ignored-action flip: ignored-first then enqueue dedupes without creating work", async () => {
    const ref = makePrRef("flip-ign-first");
    const delivery = "delivery-flip-ign-first";

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("labeled", delivery),
      ref,
      "labeled",
      intakeLog(),
      intakeCfg,
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", delivery),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    await expect(countWebhookRows(delivery)).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(0);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(0);

    const { rows } = await pool.query<{ processing_decision: string }>(
      "SELECT processing_decision FROM webhook_events WHERE event_name = $1",
      [EVENT],
    );
    expect(rows[0]?.processing_decision).toBe("ignored_pull_request_labeled");
  });
});
