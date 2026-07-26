import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss, SendOptions } from "pg-boss";
import { applyAutomatedPullRequestIntake } from "../../src/agentWork/intake/applier.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import type { PrRef, QueueConfig, WebhookHeaders } from "../../src/agentWork/types.js";
import { prResourceKey, reviewSingletonKey } from "../../src/agentWork/types.js";
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

function withFindJobsGate(
  realBoss: PgBoss,
  shouldGate: (queue: string, options?: Parameters<PgBoss["findJobs"]>[1]) => boolean,
  onGateEntered: () => void,
): { releaseGate: () => void; restore: () => void } {
  let releaseGate!: () => void;
  const gateHeld = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const originalFindJobs = realBoss.findJobs.bind(realBoss);
  realBoss.findJobs = (async <T>(name: string, options?: Parameters<PgBoss["findJobs"]>[1]) => {
    const jobs = await originalFindJobs<T>(name, options);
    if (shouldGate(name, options) && jobs.length > 0) {
      onGateEntered();
      await gateHeld;
    }
    return jobs;
  }) as PgBoss["findJobs"];
  return {
    releaseGate: () => releaseGate(),
    restore: () => {
      realBoss.findJobs = originalFindJobs;
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

async function activatePgBossJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE pgboss.job
        SET state = 'active', started_on = now(), heartbeat_on = now()
      WHERE id = $1`,
    [jobId],
  );
}

describe.skipIf(!hasDatabase)("intake transaction and singleton visibility (integration)", () => {
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

  async function reviewJobsFor(ref: PrRef) {
    const key = reviewSingletonKey(prResourceKey(ref.owner, ref.repo, ref.prNumber));
    return boss.findJobs(REVIEW_QUEUE, { key });
  }

  function latestCreatedReviewJob(jobs: Awaited<ReturnType<typeof reviewJobsFor>>) {
    return jobs.find((job) => job.state === "created") ?? jobs.at(-1);
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
    const failingBoss = withSendFailOnNth(boss, 2);
    try {
      await expect(
        applyAutomatedPullRequestIntake(
          boss,
          pool,
          headers("synchronize", delivery),
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
    await expect(countWorkItems()).resolves.toBe(0);
    await expect(boss.findJobs(ACK_QUEUE, {})).resolves.toHaveLength(0);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(0);
  });

  it("supersede flow: second delivery supersedes work item and cancels first review job", async () => {
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

    const firstJob = firstJobId ? await boss.getJobById(REVIEW_QUEUE, firstJobId) : null;
    expect(firstJob?.state).toBe("cancelled");

    const liveReviewJobs = (await reviewJobsFor(ref)).filter((job) => job.state === "created");
    expect(liveReviewJobs).toHaveLength(1);
    expect(liveReviewJobs[0]?.id).not.toBe(firstJobId);
  });

  it("cancel-visibility: poller activates job while supersede cancel is held in open transaction", async () => {
    const ref = makePrRef("cancel-vis");
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-cancel-a"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    const reviewJobsAfterA = await reviewJobsFor(ref);
    const createdJobA = latestCreatedReviewJob(reviewJobsAfterA);
    expect(createdJobA?.state).toBe("created");

    let gateEnteredResolve!: () => void;
    const gateEntered = new Promise<void>((resolve) => {
      gateEnteredResolve = resolve;
    });

    const { releaseGate, restore } = withFindJobsGate(
      boss,
      (queue, options) => queue === REVIEW_QUEUE && options?.db != null,
      () => gateEnteredResolve(),
    );

    const intakeB = applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-cancel-b"),
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );

    await Promise.race([
      gateEntered,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("supersede findJobs gate timed out")), 10_000);
      }),
    ]);

    try {
      expect(createdJobA?.id).toBeDefined();
      await activatePgBossJob(pool, createdJobA!.id);
      const activeJob = await boss.getJobById(REVIEW_QUEUE, createdJobA!.id);
      expect(activeJob?.state).toBe("active");

      releaseGate();
      await intakeB;

      const cancelledA = await boss.getJobById(REVIEW_QUEUE, createdJobA!.id);
      expect(cancelledA?.state).toBe("cancelled");

      const liveReviewJobs = (await reviewJobsFor(ref)).filter((job) => job.state === "created");
      expect(liveReviewJobs).toHaveLength(1);
      expect(liveReviewJobs[0]?.id).not.toBe(createdJobA?.id);
    } finally {
      restore();
    }
  });

  it("failed singleton: next auto delivery deletes failed blocker and enqueues runnable job", async () => {
    const ref = makePrRef("failed-block");
    const singletonKey = reviewSingletonKey(prResourceKey(ref.owner, ref.repo, ref.prNumber));

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

    // Simulate crash/expire terminal failure left on the key (blocks key_strict_fifo).
    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      firstJobId,
    ]);
    await expect(boss.getBlockedKeys(REVIEW_QUEUE)).resolves.toContain(singletonKey);

    // Mark work item terminal so supersede has nothing live to cancel — mirrors
    // the issue where app state never started but pg-boss left failed.
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

    const failedJob = await boss.getJobById(REVIEW_QUEUE, firstJobId);
    expect(failedJob).toBeNull();

    const liveReviewJobs = (await reviewJobsFor(ref)).filter((job) => job.state === "created");
    expect(liveReviewJobs).toHaveLength(1);
    expect(liveReviewJobs[0]?.id).not.toBe(firstJobId);

    const blocked = await boss.getBlockedKeys(REVIEW_QUEUE);
    expect(blocked).not.toContain(singletonKey);
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
