import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss, SendOptions } from "pg-boss";
import { applyAutomatedPullRequestIntake } from "../../src/agentWork/intake/applier.js";
import {
  applySlashCommandIntake,
  type SlashCommandInput,
} from "../../src/agentWork/intake/slashIntake.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import type {
  AckJobData,
  CiProjectionJobData,
  PrRef,
  QueueConfig,
  WebhookHeaders,
} from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOperationLogger, initEvlog } from "../../src/evlog.js";
import { makeTestConfig } from "../helpers/config.js";
import { executeAckJob } from "../../src/agentWork/executors/ackExecutor.js";
import * as installationToken from "../../src/github/installationToken.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as prSurface from "../../src/github/prSurface.js";

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
  AUTO_TRIGGER_ACTIONS,
  CI_PROJECTION_QUEUE,
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
  SLASH_REVIEW_FORCE_RESTARTED_BODY,
  REVIEW_SUMMARY_SENTINEL,
} from "../../src/settings/index.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "intake-tx-it";
const EVENT = "intake-tx-it";
const DATABASE_URL = process.env.DATABASE_URL!;
const CLEANUP_QUEUES = [ACK_QUEUE, REVIEW_QUEUE, CI_PROJECTION_QUEUE] as const;

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
  const projections = await boss.findJobs<{ owner: string }>(CI_PROJECTION_QUEUE, {});
  const owned = projections.filter((job) => job.data.owner === OWNER);
  if (owned.length > 0) {
    await boss.deleteJob(
      CI_PROJECTION_QUEUE,
      owned.map((job) => job.id),
    );
  }
}

describe.skipIf(!hasDatabase)("intake transaction (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    if (
      (await pool.query("SELECT to_regclass('public.pr_review_lifecycle') AS relation")).rows[0]
        .relation
    ) {
      await pool.query("DELETE FROM pr_review_lifecycle WHERE resource_key LIKE $1", [
        `${OWNER}/%`,
      ]);
    }
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await pool.query("DELETE FROM webhook_delivery_duplicates WHERE event_name = $1", [EVENT]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteQueueJobs(boss);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    if (
      (await pool.query("SELECT to_regclass('public.pr_review_lifecycle') AS relation")).rows[0]
        .relation
    ) {
      await pool.query("DELETE FROM pr_review_lifecycle WHERE resource_key LIKE $1", [
        `${OWNER}/%`,
      ]);
    }
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await pool.query("DELETE FROM webhook_delivery_duplicates WHERE event_name = $1", [EVENT]);
    await deleteQueueJobs(boss);
    initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it.each(["queued", "running"] as const)(
    "close commits before delayed opened: no active review survives (%s predecessor)",
    async (status) => {
      const ref = makePrRef();
      const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
      const cfg = makeTestConfig({
        features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
      });
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("opened", randomUUID()),
        ref,
        "opened",
        intakeLog(),
        cfg,
      );
      const predecessor = (
        await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [key])
      ).rows[0].id;
      await pool.query("UPDATE agent_work_items SET status = $2 WHERE id = $1", [
        predecessor,
        status,
      ]);
      const close = headers("closed", randomUUID());
      const opts = {
        merged: false,
        lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:01Z" },
      } as const;
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        close,
        ref,
        "closed",
        intakeLog(),
        cfg,
        opts,
      );
      const opened = headers("opened", randomUUID());
      await applyAutomatedPullRequestIntake(boss, pool, opened, ref, "opened", intakeLog(), cfg);
      const rows = (
        await pool.query(
          "SELECT id, status, payload FROM agent_work_items WHERE resource_key = $1",
          [key],
        )
      ).rows;
      expect(rows.filter((row) => ["queued", "running"].includes(row.status))).toEqual([]);
      expect(rows).toEqual([expect.objectContaining({ id: predecessor, status: "cancelled" })]);
      const owner = (
        await pool.query(
          "SELECT work_item_id FROM publish_records WHERE resource_key = $1 AND step = 'progress_comment'",
          [key],
        )
      ).rows[0];
      expect(owner.work_item_id).toBe(predecessor);
      const acks = await boss.findJobs<AckJobData>(ACK_QUEUE, {});
      expect(acks.filter((job) => job.data.delivery === opened.delivery)).toEqual([]);
      expect(acks.find((job) => job.data.delivery === close.delivery)?.data.cancelProgress).toEqual(
        {
          workItemId: predecessor,
          cancelledWorkItemIds: [predecessor],
          attribution: { kind: "closed" },
        },
      );
      expect(
        (
          await pool.query(
            "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
            [opened.delivery],
          )
        ).rows[0].processing_decision,
      ).toBe("ignored_review_pr_closed");
    },
  );

  it.each(["close-first", "open-first"] as const)(
    "overlapping close/open commits leave no active review: %s",
    async (order) => {
      const ref = makePrRef();
      const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
      const cfg = makeTestConfig({
        features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
      });
      if (order === "close-first") {
        await applyAutomatedPullRequestIntake(
          boss,
          pool,
          headers("opened", randomUUID()),
          ref,
          "opened",
          intakeLog(),
          cfg,
        );
      }
      const client = await pool.connect();
      const observer = await pool.connect();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => client);
      const originalSend = boss.send.bind(boss);
      let resume!: () => void;
      let paused = false;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const send = vi
        .spyOn(boss, "send")
        .mockImplementation(async (name: string, data?: object | null, options?: SendOptions) => {
          const id = await originalSend(name, data, options);
          if (
            (order === "open-first" && name === REVIEW_QUEUE) ||
            (order === "close-first" && name === ACK_QUEUE && data && "cancelProgress" in data)
          ) {
            paused = true;
            await gate;
          }
          return id;
        });
      const close = headers("closed", randomUUID());
      const open = headers("opened", randomUUID());
      const closeOpts = {
        merged: false,
        lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:01Z" },
      } as const;
      const runs: Promise<void>[] = [];
      try {
        runs.push(
          order === "open-first"
            ? applyAutomatedPullRequestIntake(boss, pool, open, ref, "opened", intakeLog(), cfg)
            : applyAutomatedPullRequestIntake(
                boss,
                pool,
                close,
                ref,
                "closed",
                intakeLog(),
                cfg,
                closeOpts,
              ),
        );
        void runs[0].catch(() => undefined);
        await expect.poll(() => paused, { timeout: 5000 }).toBe(true);
        runs.push(
          order === "open-first"
            ? applyAutomatedPullRequestIntake(
                boss,
                pool,
                close,
                ref,
                "closed",
                intakeLog(),
                cfg,
                closeOpts,
              )
            : applyAutomatedPullRequestIntake(boss, pool, open, ref, "opened", intakeLog(), cfg),
        );
        void runs[1].catch(() => undefined);
        await expect
          .poll(
            async () =>
              (
                await observer.query(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
                  [pid],
                )
              ).rows[0].blocked,
            { timeout: 5000 },
          )
          .toBe(true);
        resume();
        await Promise.all(runs);
      } finally {
        resume();
        await Promise.allSettled(runs);
        send.mockRestore();
        connect.mockRestore();
        observer.release();
      }
      const work = (
        await pool.query("SELECT id, status FROM agent_work_items WHERE resource_key = $1", [key])
      ).rows;
      expect(work).toEqual([expect.objectContaining({ status: "cancelled" })]);
      const jobs = await boss.findJobs<AckJobData>(ACK_QUEUE, {});
      const cancel = jobs.find((job) => job.data.delivery === close.delivery)!.data;
      const progress =
        jobs.find((job) => job.data.delivery === open.delivery)?.data ??
        jobs.find((job) => job.data.workItemId === work[0].id)!.data;
      const fake = prSurface.createFakePrSurface(ref);
      const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "test-token",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      });
      const bot = vi
        .spyOn(appAuth, "getAppBotIdentity")
        .mockResolvedValue({ userId: 999, login: "test-bot" });
      const surface = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      try {
        for (const ack of order === "open-first" ? [progress, cancel] : [cancel, progress]) {
          await executeAckJob(makeTestConfig(), pool, ack, boss);
        }
        const body = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
        expect(body).toContain("PR closed.");
        expect(body).not.toContain("Review queued");
        expect(body).not.toContain("| Recon");
      } finally {
        token.mockRestore();
        bot.mockRestore();
        surface.mockRestore();
      }
    },
  );

  it("production review admission refuses opened, approval and synchronize until a newer reopen; preserves supersede afterward", async () => {
    const ref = makePrRef();
    const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const cfg = makeTestConfig({
      features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
    });
    const triggers = [...AUTO_TRIGGER_ACTIONS.review];
    AUTO_TRIGGER_ACTIONS.review.delete("synchronize");
    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("opened", randomUUID()),
        ref,
        "opened",
        intakeLog(),
        cfg,
      );
      const opts = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:02Z" } } as const;
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("closed", randomUUID()),
        ref,
        "closed",
        intakeLog(),
        cfg,
        opts,
      );
      for (const action of ["opened", "approval", "synchronize"]) {
        const log = intakeLog();
        const h = headers(action, randomUUID());
        await applyAutomatedPullRequestIntake(
          boss,
          pool,
          h,
          ref,
          action,
          log,
          action === "approval" ? { features: { ...cfg.features, review: "approval" } } : cfg,
        );
        expect(
          (
            await pool.query(
              "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
              [h.delivery],
            )
          ).rows[0].processing_decision,
        ).toBe("ignored_review_pr_closed");
      }
      expect(
        (await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [key]))
          .rows,
      ).toEqual([{ status: "cancelled" }]);
      const reopen = { lifecycle: { state: "open", observedAt: "2026-10-01T00:00:03Z" } } as const;
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("reopened", randomUUID()),
        ref,
        "reopened",
        intakeLog(),
        cfg,
        reopen,
      );
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("opened", randomUUID()),
        ref,
        "opened",
        intakeLog(),
        cfg,
      );
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("synchronize", randomUUID()),
        ref,
        "synchronize",
        intakeLog(),
        cfg,
      );
      expect(
        (
          await pool.query(
            "SELECT status FROM agent_work_items WHERE resource_key = $1 ORDER BY created_at",
            [key],
          )
        ).rows.map((row) => row.status),
      ).toEqual(["cancelled", "superseded", "queued"]);
    } finally {
      AUTO_TRIGGER_ACTIONS.review.clear();
      for (const action of triggers) AUTO_TRIGGER_ACTIONS.review.add(action);
    }
  });

  it.each(["closed", "merged"] as const)(
    "zero-work %s blocks slash review/force with actual replies; duplicates add no jobs",
    async (state) => {
      const ref = makePrRef();
      const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
      const cfg = makeTestConfig({
        features: { ...intakeCfg.features, review: "manual", describe: "off", verification: "off" },
      });
      const close = headers("closed", randomUUID());
      const opts = {
        merged: state === "merged",
        lifecycle: { state, observedAt: "2026-10-01T00:00:02Z" },
      };
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        close,
        ref,
        "closed",
        intakeLog(),
        cfg,
        opts,
      );
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        close,
        ref,
        "closed",
        intakeLog(),
        cfg,
        opts,
      );
      expect(await boss.findJobs(ACK_QUEUE, {})).toEqual([]);
      const fake = prSurface.createFakePrSurface(ref);
      const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "test-token",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      });
      const bot = vi
        .spyOn(appAuth, "getAppBotIdentity")
        .mockResolvedValue({ userId: 999, login: "test-bot" });
      const surface = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      try {
        for (const force of [false, true]) {
          const input: SlashCommandInput = {
            ...ref,
            headers: headers("review", randomUUID()),
            command: "review",
            body: force ? "/review force" : "/review",
            commentId: force ? 650 : 649,
            commenterId: 649,
            replyTarget: force
              ? { kind: "inlineReviewThread", prNumber: ref.prNumber, inReplyToCommentId: 650 }
              : { kind: "prConversation", prNumber: ref.prNumber },
          };
          const client = await pool.connect();
          try {
            for (let i = 0; i < 2; i++) {
              await client.query("BEGIN");
              await applySlashCommandIntake(boss, client, input, cfg.features);
              await client.query("COMMIT");
            }
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
          const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).filter(
            (job) => job.data.delivery === input.headers.delivery,
          );
          expect(ack).toHaveLength(1);
          expect(ack[0].data.workItemId).toBeUndefined();
          expect(ack[0].data.progress).toBeUndefined();
          expect(ack[0].data.cancelProgress).toBeUndefined();
          const body =
            state === "closed"
              ? "This pull request is closed. Reopen it before running `/review`."
              : "This pull request is merged. Run `/review` on an open pull request.";
          await executeAckJob(makeTestConfig(), pool, ack[0].data, boss);
          expect(fake.controls.replies.at(-1)).toEqual({ target: input.replyTarget, body });
          expect(
            (
              await pool.query(
                "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
                [input.headers.delivery],
              )
            ).rows[0].processing_decision,
          ).toBe(`ignored_slash_review_pr_${state}`);
        }
        expect(
          (await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [key])).rows,
        ).toEqual([]);
        expect(
          (await pool.query("SELECT id FROM publish_records WHERE resource_key = $1", [key])).rows,
        ).toEqual([]);
        expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)).toBeNull();
        const reopen = {
          lifecycle: { state: "open", observedAt: "2026-10-01T00:00:03Z" },
        } as const;
        await applyAutomatedPullRequestIntake(
          boss,
          pool,
          headers("reopened", randomUUID()),
          ref,
          "reopened",
          intakeLog(),
          cfg,
          reopen,
        );
        expect(
          (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
            .rows[0].state,
        ).toBe(state === "closed" ? "open" : "merged");
      } finally {
        token.mockRestore();
        bot.mockRestore();
        surface.mockRestore();
      }
    },
  );

  it("orders lifecycle transitions, conservatively ties closed, preserves retention, and reopens in manual mode without CI work", async () => {
    const ref = makePrRef();
    const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const cfg = makeTestConfig({
      features: { ...intakeCfg.features, review: "manual", describe: "off", verification: "off" },
    });
    await pool.query(
      "INSERT INTO pr_head_ci_state(owner,repo,head_sha,rollup,version,seeded_at) VALUES ($1,$2,$3,'none',1,now()) ON CONFLICT (owner,repo,head_sha) DO UPDATE SET seeded_at = now()",
      [ref.owner, ref.repo, ref.headSha],
    );
    for (const [action, state, time, expected] of [
      ["closed", "closed", 2, "closed"],
      ["reopened", "open", 1, "closed"],
      ["reopened", "open", 2, "closed"],
      ["reopened", "open", 3, "open"],
      ["closed", "closed", 2, "open"],
      ["closed", "closed", 3, "closed"],
    ] as const) {
      const h = headers(action, randomUUID());
      const opts = { lifecycle: { state, observedAt: `2026-10-01T00:00:0${time}Z` } };
      await applyAutomatedPullRequestIntake(boss, pool, h, ref, action, intakeLog(), cfg, opts);
      expect(
        (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
          .rows[0].state,
      ).toBe(expected);
      if (state !== expected) {
        expect(
          (
            await pool.query(
              "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
              [h.delivery],
            )
          ).rows[0].processing_decision,
        ).toBe("ignored_stale_pr_lifecycle");
      }
    }
    expect(
      (await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [key])).rows,
    ).toEqual([]);
    expect(
      (await boss.findJobs<CiProjectionJobData>(CI_PROJECTION_QUEUE, {})).filter(
        (job) => job.data.owner === ref.owner && job.data.repo === ref.repo,
      ),
    ).toEqual([]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    expect(
      (
        await pool.query(
          "SELECT state, webhook_event_id FROM pr_review_lifecycle WHERE resource_key = $1",
          [key],
        )
      ).rows,
    ).toEqual([{ state: "closed", webhook_event_id: null }]);
    const reopen = { lifecycle: { state: "open", observedAt: "2026-10-01T00:00:04Z" } } as const;
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("reopened", randomUUID()),
      ref,
      "reopened",
      intakeLog(),
      cfg,
      reopen,
    );
    const input: SlashCommandInput = {
      ...ref,
      headers: headers("review", randomUUID()),
      command: "review",
      body: "/review",
      commentId: 649,
      commenterId: 649,
      replyTarget: { kind: "prConversation", prNumber: ref.prNumber },
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applySlashCommandIntake(boss, client, input, cfg.features);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const stale = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:03Z" } } as const;
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("closed", randomUUID()),
      ref,
      "closed",
      intakeLog(),
      cfg,
      stale,
    );
    expect(
      (await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [key])).rows,
    ).toEqual([{ status: "queued" }]);
  });

  it("close send failure rolls back marker, cancellation and reservations; retry establishes the gate", async () => {
    const ref = makePrRef();
    const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const cfg = makeTestConfig({
      features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
    });
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("opened", randomUUID()),
      ref,
      "opened",
      intakeLog(),
      cfg,
    );
    const h = headers("closed", randomUUID());
    const opts = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:02Z" } } as const;
    const failure = withSendFailOnNth(boss, 1);
    try {
      await expect(
        applyAutomatedPullRequestIntake(boss, pool, h, ref, "closed", intakeLog(), cfg, opts),
      ).rejects.toThrow("injected send failure");
    } finally {
      failure.restore();
    }
    expect(
      (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
        .rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [key])).rows,
    ).toEqual([{ status: "queued" }]);
    await expect(countWebhookRows(h.delivery)).resolves.toBe(0);
    await expect(countReplayRows(h.rawBody)).resolves.toBe(0);
    await applyAutomatedPullRequestIntake(boss, pool, h, ref, "closed", intakeLog(), cfg, opts);
    expect(
      (await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [key])).rows,
    ).toEqual([{ status: "cancelled" }]);
  });

  it.each(["opened", "synchronize"])(
    "closed review refusal preserves enabled non-review work and CI: %s",
    async (action) => {
      const ref = makePrRef();
      const cfg = makeTestConfig();
      const opts = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:02Z" } } as const;
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("closed", randomUUID()),
        ref,
        "closed",
        intakeLog(),
        cfg,
        opts,
      );
      const h = headers(action, randomUUID());
      initEvlog("info", { silent: true, suppressDrainWarning: true });
      const log = intakeLog();
      await applyAutomatedPullRequestIntake(boss, pool, h, ref, action, log, cfg);
      expect(
        (
          await pool.query("SELECT type FROM agent_work_items WHERE resource_key = $1", [
            prResourceKey(ref.owner, ref.repo, ref.prNumber),
          ])
        ).rows,
      ).toEqual([{ type: action === "opened" ? "description" : "verification" }]);
      expect(
        (
          await pool.query(
            "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
            [h.delivery],
          )
        ).rows[0].processing_decision,
      ).toBe("automated_work_enqueued");
      expect(log.getContext().events).toContainEqual(
        expect.objectContaining({
          event: "review_intake_refused",
          reason: "closed",
          delivery: h.delivery,
        }),
      );
      expect(
        (await boss.findJobs<CiProjectionJobData>(CI_PROJECTION_QUEUE, {})).some(
          (job) => job.data.owner === ref.owner && job.data.repo === ref.repo,
        ),
      ).toBe(true);
    },
  );

  it.each(["reopen-first", "review-first"] as const)(
    "reopen and slash review serialize admission through commit: %s",
    async (order) => {
      const ref = makePrRef();
      const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
      const cfg = makeTestConfig({
        features: { ...intakeCfg.features, review: "manual", describe: "off", verification: "off" },
      });
      const closed = {
        lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:01Z" },
      } as const;
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        headers("closed", randomUUID()),
        ref,
        "closed",
        intakeLog(),
        cfg,
        closed,
      );
      const client = await pool.connect();
      const observer = await pool.connect();
      const reviewClient = await pool.connect();
      const reopenPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const reviewPid = (await reviewClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const query = client.query.bind(client);
      let resume!: () => void;
      let paused = false;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const spy = vi
        .spyOn(client, "query")
        .mockImplementation(async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql.includes("INSERT INTO pr_review_lifecycle") && order === "reopen-first") {
            paused = true;
            await gate;
          }
          return result;
        });
      const input: SlashCommandInput = {
        ...ref,
        headers: headers("review", randomUUID()),
        command: "review",
        body: "/review",
        commentId: 649,
        commenterId: 649,
        replyTarget: { kind: "prConversation", prNumber: ref.prNumber },
      };
      const reopen = { lifecycle: { state: "open", observedAt: "2026-10-01T00:00:02Z" } } as const;
      const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => client);
      let reopenRun: Promise<void> | undefined;
      let reviewRun: ReturnType<typeof applySlashCommandIntake> | undefined;
      let committed = false;
      try {
        await reviewClient.query("BEGIN");
        if (order === "review-first")
          await applySlashCommandIntake(boss, reviewClient, input, cfg.features);
        reopenRun = applyAutomatedPullRequestIntake(
          boss,
          pool,
          headers("reopened", randomUUID()),
          ref,
          "reopened",
          intakeLog(),
          cfg,
          reopen,
        );
        void reopenRun.catch(() => undefined);
        if (order === "reopen-first") {
          await expect.poll(() => paused, { timeout: 5000 }).toBe(true);
          reviewRun = applySlashCommandIntake(boss, reviewClient, input, cfg.features);
          void reviewRun.catch(() => undefined);
        }
        const waitingPid = order === "reopen-first" ? reviewPid : reopenPid;
        await expect
          .poll(
            async () =>
              (
                await observer.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
                  waitingPid,
                ])
              ).rows[0].blocked,
            { timeout: 5000 },
          )
          .toBe(true);
        if (order === "reopen-first") {
          resume();
          await reopenRun;
          await reviewRun;
        }
        await reviewClient.query("COMMIT");
        committed = true;
        await reopenRun;
      } finally {
        resume();
        if (!committed) await reviewClient.query("ROLLBACK");
        await Promise.allSettled([reopenRun, reviewRun].filter((run) => run != null));
        connect.mockRestore();
        spy.mockRestore();
        observer.release();
        reviewClient.release();
      }
      expect(
        (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
          .rows,
      ).toEqual([{ state: "open" }]);
      const work = (
        await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [key])
      ).rows;
      expect(work).toEqual(order === "reopen-first" ? [{ status: "queued" }] : []);
      const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).find(
        (job) => job.data.delivery === input.headers.delivery,
      )!.data;
      if (order === "reopen-first")
        expect(ack.progress).toMatchObject({ lens: "review", source: "slash" });
      else expect(ack.reply?.body).toContain("Reopen it before");
    },
  );

  it("zero-work close refuses delayed auto/approval without blocking another repository with the same PR number", async () => {
    const ref = makePrRef();
    const cfg = makeTestConfig({
      features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
    });
    const close = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:01Z" } } as const;
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("closed", randomUUID()),
      ref,
      "closed",
      intakeLog(),
      cfg,
      close,
    );
    for (const action of ["opened", "approval"]) {
      const h = headers(action, randomUUID());
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        h,
        ref,
        action,
        intakeLog(),
        action === "approval" ? { features: { ...cfg.features, review: "approval" } } : cfg,
      );
      await applyAutomatedPullRequestIntake(boss, pool, h, ref, action, intakeLog(), cfg);
    }
    expect(
      (
        await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [
          prResourceKey(ref.owner, ref.repo, ref.prNumber),
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).filter((job) => job.data.repo === ref.repo),
    ).toEqual([]);
    const other = { ...ref, repo: `${ref.repo}-other` };
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("opened", randomUUID()),
      other,
      "opened",
      intakeLog(),
      cfg,
    );
    expect(
      (
        await pool.query("SELECT status FROM agent_work_items WHERE resource_key = $1", [
          prResourceKey(other.owner, other.repo, other.prNumber),
        ])
      ).rows,
    ).toEqual([{ status: "queued" }]);
  });

  it("reopen enqueue failure leaves the closed predicate and retry reservations intact until a successful retry", async () => {
    const ref = makePrRef();
    const key = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const cfg = makeTestConfig({
      features: { ...intakeCfg.features, review: "manual", describe: "off", verification: "off" },
    });
    const close = { lifecycle: { state: "closed", observedAt: "2026-10-01T00:00:01Z" } } as const;
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("closed", randomUUID()),
      ref,
      "closed",
      intakeLog(),
      cfg,
      close,
    );
    const h = headers("reopened", randomUUID());
    const reopen = { lifecycle: { state: "open", observedAt: "2026-10-01T00:00:02Z" } } as const;
    const send = vi
      .spyOn(boss, "sendDebounced")
      .mockRejectedValueOnce(new Error("injected reopen seed failure"));
    try {
      await expect(
        applyAutomatedPullRequestIntake(boss, pool, h, ref, "reopened", intakeLog(), cfg, reopen),
      ).rejects.toThrow("injected reopen seed failure");
    } finally {
      send.mockRestore();
    }
    expect(
      (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
        .rows,
    ).toEqual([{ state: "closed" }]);
    await expect(countWebhookRows(h.delivery)).resolves.toBe(0);
    await expect(countReplayRows(h.rawBody)).resolves.toBe(0);
    await applyAutomatedPullRequestIntake(boss, pool, h, ref, "reopened", intakeLog(), cfg, reopen);
    await applyAutomatedPullRequestIntake(boss, pool, h, ref, "reopened", intakeLog(), cfg, reopen);
    expect(
      (await pool.query("SELECT state FROM pr_review_lifecycle WHERE resource_key = $1", [key]))
        .rows,
    ).toEqual([{ state: "open" }]);
    await expect(countWebhookRows(h.delivery)).resolves.toBe(1);
  });

  it.each(["auto-first", "force-first"] as const)(
    "serializes real automatic review and forced slash intake: %s",
    async (order) => {
      const ref = makePrRef();
      const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
      const cfg = makeTestConfig({
        features: { ...intakeCfg.features, review: "auto", describe: "off", verification: "off" },
      });
      const forcedHeaders = headers("force", randomUUID());
      const input: SlashCommandInput = {
        ...ref,
        headers: forcedHeaders,
        command: "review",
        body: "/review force",
        commentId: 647,
        commenterId: 647,
        commenterLogin: "force-user",
        replyTarget: { kind: "prConversation", prNumber: ref.prNumber },
      };
      const client = await pool.connect();
      const observer = await pool.connect();
      const originalSend = boss.send.bind(boss);
      let releaseAuto!: () => void;
      const autoGate = new Promise<void>((resolve) => {
        releaseAuto = resolve;
      });
      let autoPaused = false;
      const sendSpy =
        order === "auto-first"
          ? vi
              .spyOn(boss, "send")
              .mockImplementation(
                async (name: string, data?: object | null, options?: SendOptions) => {
                  const id = await originalSend(name, data, options);
                  if (name === REVIEW_QUEUE) {
                    autoPaused = true;
                    await autoGate;
                  }
                  return id;
                },
              )
          : undefined;
      let committed = false;
      let autoRun: ReturnType<typeof applyAutomatedPullRequestIntake> | undefined;
      let forceRun: ReturnType<typeof applySlashCommandIntake> | undefined;
      try {
        await client.query("BEGIN");
        const forcePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        if (order === "force-first") {
          await applySlashCommandIntake(boss, client, input, cfg.features);
        }
        autoRun = applyAutomatedPullRequestIntake(
          boss,
          pool,
          headers("opened", randomUUID()),
          ref,
          "opened",
          intakeLog(),
          cfg,
        );
        void autoRun.catch(() => undefined);
        if (order === "auto-first") {
          await expect.poll(() => autoPaused, { timeout: 5000 }).toBe(true);
          forceRun = applySlashCommandIntake(boss, client, input, cfg.features);
          void forceRun.catch(() => undefined);
          await expect
            .poll(
              async () =>
                (
                  await observer.query<{ blocked: boolean }>(
                    "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
                    [forcePid],
                  )
                ).rows[0].blocked,
              { timeout: 5000 },
            )
            .toBe(true);
          releaseAuto();
          await autoRun;
          await forceRun;
          await client.query("COMMIT");
          committed = true;
        } else {
          await expect
            .poll(
              async () =>
                (
                  await observer.query<{ blocked: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
                    [forcePid],
                  )
                ).rows[0].blocked,
              { timeout: 5000 },
            )
            .toBe(true);
          await client.query("COMMIT");
          committed = true;
          await autoRun;
        }
      } finally {
        releaseAuto();
        if (!committed) await client.query("ROLLBACK");
        if (autoRun) await autoRun.catch(() => undefined);
        if (forceRun) await forceRun.catch(() => undefined);
        sendSpy?.mockRestore();
        client.release();
        observer.release();
      }
      const { rows } = await pool.query<{ id: string; source: string; status: string }>(
        "SELECT id, source, status FROM agent_work_items WHERE resource_key = $1 ORDER BY created_at, id",
        [resourceKey],
      );
      expect(rows).toHaveLength(2);
      const auto = rows.find((row) => row.source === "auto")!;
      const slash = rows.find((row) => row.source === "slash")!;
      expect(slash.status).toBe("queued");
      expect(auto.status).toBe(order === "auto-first" ? "cancelled" : "queued");
      const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).find(
        (job) => job.data.delivery === forcedHeaders.delivery,
      )!.data;
      expect(ack.workItemId).toBe(slash.id);
      expect(ack.progress).toMatchObject({ lens: "review", source: "slash" });
      if (order === "auto-first") {
        expect(ack.cancelProgress?.cancelledWorkItemIds).toEqual([auto.id]);
        expect(ack.reply?.body).toBe(SLASH_REVIEW_FORCE_RESTARTED_BODY);
      } else {
        expect(ack.cancelProgress).toBeUndefined();
        expect(ack.reply).toBeUndefined();
      }
      const progress = await pool.query<{ work_item_id: string }>(
        "SELECT work_item_id FROM publish_records WHERE resource_key = $1 AND step = 'progress_comment'",
        [resourceKey],
      );
      expect(progress.rows[0]?.work_item_id).toBe(order === "auto-first" ? slash.id : auto.id);
      const jobs = await reviewJobsFor(ref);
      expect(jobs.map((job) => job.data.workItemId).toSorted()).toEqual(
        [auto.id, slash.id].toSorted(),
      );
    },
  );

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
    const jobs = await boss.findJobs<{ workItemId: string }>(REVIEW_QUEUE, {});
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

  it.each(["body_replay", "delivery_key", "delivery_key_changed_body"])(
    "records every rejected arrival without creating work or jobs: %s",
    async (variant) => {
      const ref = makePrRef(variant);
      const original = headers("synchronize", `delivery-${variant}-a`);
      const duplicate = {
        ...original,
        delivery: variant === "body_replay" ? `delivery-${variant}-b` : original.delivery,
        rawBody:
          variant === "delivery_key_changed_body"
            ? headers("synchronize", "changed-body").rawBody
            : original.rawBody,
      };
      const bodySha256 = createHash("sha256").update(duplicate.rawBody).digest("hex");
      const reason = variant === "body_replay" ? "body_replay" : "delivery_key";
      const jobsSql = `SELECT id, name FROM pgboss.job
        WHERE (name = $1 AND data->>'workItemId' IN (
                 SELECT id::text FROM agent_work_items
                  WHERE owner = $4 AND repo = $5 AND pr_number = $6))
           OR (name = $2 AND data->>'owner' = $4 AND data->>'repo' = $5
                        AND data->>'prNumber' = $6::text)
           OR (name = $3 AND data->>'owner' = $4 AND data->>'repo' = $5
                        AND data->>'headSha' = $7)
        ORDER BY name, id`;
      const jobParams = [
        REVIEW_QUEUE,
        ACK_QUEUE,
        CI_PROJECTION_QUEUE,
        ref.owner,
        ref.repo,
        ref.prNumber,
        ref.headSha,
      ];
      expect((await pool.query(jobsSql, jobParams)).rows).toEqual([]);
      let acceptedJobs: Array<{ id: string; name: string }> = [];

      for (const [index, requestHeaders] of [original, duplicate, duplicate].entries()) {
        await applyAutomatedPullRequestIntake(
          boss,
          pool,
          requestHeaders,
          ref,
          "synchronize",
          intakeLog(),
          intakeCfg,
        );
        const jobs = await pool.query<{ id: string; name: string }>(jobsSql, jobParams);
        if (index === 0) {
          acceptedJobs = jobs.rows;
          expect(acceptedJobs.map((job) => job.name).toSorted()).toEqual(
            [ACK_QUEUE, REVIEW_QUEUE, CI_PROJECTION_QUEUE].toSorted(),
          );
        } else {
          expect(jobs.rows).toEqual(acceptedJobs);
        }
        await expect(countWebhookRows()).resolves.toBe(1);
        await expect(countWorkItems()).resolves.toBe(1);
        const { rows } = await pool.query<{
          id: string;
          received_at: Date;
          delivery_id: string;
          body_sha256: string;
          dedupe_key: string;
          dedupe_reason: string;
        }>(
          `SELECT id, received_at, delivery_id, body_sha256, dedupe_key, dedupe_reason
             FROM webhook_delivery_duplicates WHERE event_name = $1 ORDER BY received_at, id`,
          [EVENT],
        );
        expect(rows).toHaveLength(index);
        expect(new Set(rows.map((row) => row.id)).size).toBe(index);
        for (const row of rows) {
          expect(row).toEqual({
            id: expect.any(String),
            received_at: expect.any(Date),
            delivery_id: duplicate.delivery,
            body_sha256: bodySha256,
            dedupe_key:
              reason === "body_replay" ? `body:${bodySha256}` : `delivery:${duplicate.delivery}`,
            dedupe_reason: reason,
          });
        }
        if (variant === "body_replay") {
          await expect(countWebhookRows(duplicate.delivery)).resolves.toBe(0);
        }
      }
    },
  );

  it("rejects failed duplicate evidence and records a subsequent retry", async () => {
    const ref = makePrRef("audit-failure");
    const original = headers("synchronize", "delivery-audit-original");
    const duplicate = { ...original, delivery: "delivery-audit-duplicate" };
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      original,
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    const jobsSql = `SELECT id FROM pgboss.job
      WHERE (name = $1 AND data->>'workItemId' IN (
               SELECT id::text FROM agent_work_items
                WHERE owner = $4 AND repo = $5 AND pr_number = $6))
         OR (name = $2 AND data->>'owner' = $4 AND data->>'repo' = $5
                      AND data->>'prNumber' = $6::text)
         OR (name = $3 AND data->>'owner' = $4 AND data->>'repo' = $5
                      AND data->>'headSha' = $7)
      ORDER BY id`;
    const jobParams = [
      REVIEW_QUEUE,
      ACK_QUEUE,
      CI_PROJECTION_QUEUE,
      ref.owner,
      ref.repo,
      ref.prNumber,
      ref.headSha,
    ];
    const jobsBefore = await pool.query(jobsSql, jobParams);
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    const querySpy = vi
      .spyOn(client, "query")
      .mockImplementation((...args: Parameters<typeof client.query>) => {
        if (
          typeof args[0] === "string" &&
          args[0].includes("INSERT INTO webhook_delivery_duplicates")
        ) {
          return Promise.reject(new Error("injected duplicate audit failure"));
        }
        return originalQuery(...args);
      });
    const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => client);
    try {
      await expect(
        applyAutomatedPullRequestIntake(
          boss,
          pool,
          duplicate,
          ref,
          "synchronize",
          intakeLog(),
          intakeCfg,
        ),
      ).rejects.toThrow("injected duplicate audit failure");
    } finally {
      querySpy.mockRestore();
      connectSpy.mockRestore();
    }
    expect(
      (
        await pool.query("SELECT id FROM webhook_delivery_duplicates WHERE event_name = $1", [
          EVENT,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(countWebhookRows()).resolves.toBe(1);
    await expect(countWorkItems()).resolves.toBe(1);
    await expect(countReplayRows(original.rawBody)).resolves.toBe(1);
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      duplicate,
      ref,
      "synchronize",
      intakeLog(),
      intakeCfg,
    );
    expect(
      (
        await pool.query(
          "SELECT delivery_id FROM webhook_delivery_duplicates WHERE event_name = $1",
          [EVENT],
        )
      ).rows,
    ).toEqual([{ delivery_id: duplicate.delivery }]);
    expect((await pool.query(jobsSql, jobParams)).rows).toEqual(jobsBefore.rows);
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

  it("approval mode: first approval enqueues one deferred-head review", async () => {
    const ref = makePrRef("approval-first");
    const approvalCfg = makeTestConfig({
      features: { ...makeTestConfig().features, review: "approval", verification: "off" },
    });

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-first"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );

    await expect(countWorkItems()).resolves.toBe(1);
    const { rows } = await pool.query<{ head_sha: string; status: string }>(
      `SELECT head_sha, status FROM agent_work_items WHERE owner = $1`,
      [OWNER],
    );
    expect(rows[0]?.head_sha).toBe("deferred-to-worker");
    expect(rows[0]?.status).toBe("queued");
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(1);
  });

  it("approval mode: repeat approval is a no-op without a second review", async () => {
    const ref = makePrRef("approval-repeat");
    const approvalCfg = makeTestConfig({
      features: { ...makeTestConfig().features, review: "approval", verification: "off" },
    });

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-repeat-a"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-repeat-b"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );

    await expect(countWorkItems()).resolves.toBe(1);
    await expect(reviewJobsFor(ref)).resolves.toHaveLength(1);
    initEvlog("info", { silent: true, suppressDrainWarning: true });
    const secondLog = intakeLog();
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-repeat-c"),
      ref,
      "approval",
      secondLog,
      approvalCfg,
    );
    await expect(countWorkItems()).resolves.toBe(1);
    const dedupEvents = (secondLog.getContext().events ?? []) as Array<{
      event?: string;
    }>;
    expect(dedupEvents.some((entry) => entry.event === "ignored_approval_review_exists")).toBe(
      true,
    );
  });

  it("approval mode: approval after a terminal review starts a fresh review", async () => {
    const ref = makePrRef("approval-terminal");
    const approvalCfg = makeTestConfig({
      features: { ...makeTestConfig().features, review: "approval", verification: "off" },
    });

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-terminal-a"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );
    await pool.query(
      `UPDATE agent_work_items SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE owner = $1`,
      [OWNER],
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-terminal-b"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );

    await expect(countWorkItems()).resolves.toBe(2);
  });

  it("approval mode: synchronize supersedes the approval-started review", async () => {
    const ref = makePrRef("approval-push");
    const approvalCfg = makeTestConfig({
      features: { ...makeTestConfig().features, review: "approval", verification: "off" },
    });

    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("approval", "delivery-approval-push-a"),
      ref,
      "approval",
      intakeLog(),
      approvalCfg,
    );
    await applyAutomatedPullRequestIntake(
      boss,
      pool,
      headers("synchronize", "delivery-approval-push-b"),
      ref,
      "synchronize",
      intakeLog(),
      approvalCfg,
    );

    const { rows: workRows } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_work_items WHERE owner = $1 ORDER BY created_at`,
      [OWNER],
    );
    expect(workRows.map((row) => row.status).toSorted()).toEqual(["queued", "superseded"]);
  });
});
