import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  applySlashCommandIntake,
  type SlashCommandInput,
} from "../../src/agentWork/intake/slashIntake.js";
import { executeAckJob } from "../../src/agentWork/executors/ackExecutor.js";
import * as installationToken from "../../src/github/installationToken.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as prSurface from "../../src/github/prSurface.js";
import { parseProgressRevisionState } from "../../src/review/run/progressComment.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import {
  acquirePrActorLease,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import {
  cancelOrphanedStaleHeadReplacementOnTerminalFailure,
  createReviewRescheduleWorkItem,
  enqueueReviewReschedule,
} from "../../src/agentWork/reviewReschedule.js";
import {
  claimWorkForExecution,
  getReviewQueuePosition,
  getWorkItem,
} from "../../src/agentWork/repository.js";
import { inTransaction } from "../../src/db/postgres.js";
import * as workItemRepository from "../../src/agentWork/intake/workItemRepository.js";
import { makeTestConfig } from "../helpers/config.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
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
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  REVIEW_SUMMARY_SENTINEL,
  SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY,
  SLASH_REVIEW_FORCE_RESTARTED_BODY,
  DESCRIPTION_ALREADY_IN_PROGRESS,
  SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY,
  TRIAGE_ALREADY_IN_PROGRESS,
  TRIAGE_FULL_RUN_IN_PROGRESS,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../../src/settings/index.js";
import type { AckJobData, QueueConfig } from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { makeReviewWorkItem } from "../helpers/agentWorkItems.js";
import { hasDatabase, integrationPool } from "./db.js";

const testFeatures = makeTestConfig().features;

const OWNER = "slash-uniq-it";
const EVENT = "slash-uniq-it";
const DATABASE_URL = process.env.DATABASE_URL!;
const CLEANUP_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_QUEUE,
] as const;

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

async function reviewJobFor(boss: PgBoss, workItemId: string) {
  const jobs = await boss.findJobs(REVIEW_QUEUE, {});
  return jobs.find((job) => (job.data as { workItemId?: string }).workItemId === workItemId);
}

async function verificationJobFor(boss: PgBoss, workItemId: string) {
  const jobs = await boss.findJobs(VERIFICATION_QUEUE, {});
  return jobs.find((job) => (job.data as { workItemId?: string }).workItemId === workItemId);
}

describe.skipIf(!hasDatabase)("slash active uniqueness (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
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
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await pool.query("DELETE FROM webhook_delivery_duplicates WHERE event_name = $1", [EVENT]);
    await deleteQueueJobs(boss);
  });

  async function acquireReviewLease(workItemId: string, resourceKey: string): Promise<number> {
    const acquisition = await acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId,
      holderId: "slash-uniq-it-holder",
      ttlSeconds: 900,
    });
    if (!acquisition.acquired) throw new Error(`expected lease acquisition for ${workItemId}`);
    return acquisition.leaseEpoch;
  }

  function makeDescribeInput(repo: string, delivery: string, commentId: number) {
    return {
      headers: {
        event: EVENT,
        delivery,
        rawBody: Buffer.from(JSON.stringify({ delivery })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 77,
      commentId,
      commenterId: 11,
      body: "/describe",
      command: "describe",
      replyTarget: { kind: "prConversation" as const, prNumber: 77 },
    };
  }

  function makeVerifyInput(repo: string, delivery: string, commentId: number) {
    return {
      headers: {
        event: EVENT,
        delivery,
        rawBody: Buffer.from(JSON.stringify({ delivery })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 78,
      commentId,
      commenterId: 11,
      body: "/verify",
      command: "verify",
      replyTarget: { kind: "prConversation" as const, prNumber: 78 },
    };
  }

  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((type) =>
      (["queued", "running"] as const).map((status) => ({ type, status })),
    ),
  )("keeps $type intake when its $status winner races cancellation", async ({ type, status }) => {
    const repo = `winner-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 77);
    const command = type === "description" ? "describe" : type === "verification" ? "verify" : type;
    const inputs: SlashCommandInput[] = [0, 1].map((index) => ({
      headers: {
        event: EVENT,
        delivery: `${repo}-${index}`,
        rawBody: Buffer.from(JSON.stringify({ repo, type, index })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 77,
      commentId: 1000 + index,
      commenterId: 11 + index,
      body: `/${command}\nRequest ${index}`,
      command,
      replyTarget: { kind: "prConversation", prNumber: 77 },
    }));
    const a = await pool.connect();
    const b = await pool.connect();
    const c = await pool.connect();
    const observer = await pool.connect();
    let aOpen = false;
    let bOpen = false;
    let cOpen = false;
    let inserted = false;
    let cancelled = false;
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const query = b.query.bind(b);
    const spy = vi.spyOn(b, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes("INSERT INTO agent_work_items")) {
        inserted = true;
        await gate;
      }
      return result;
    });
    let intake: ReturnType<typeof applySlashCommandIntake> | undefined;
    let cancellation: Promise<void> | undefined;
    let winnerId = "";
    try {
      for (const client of [a, b, c]) {
        await client.query("SET lock_timeout = '10s'");
        await client.query("SET statement_timeout = '15s'");
      }
      await a.query("BEGIN");
      aOpen = true;
      await b.query("BEGIN");
      bOpen = true;
      await c.query("BEGIN");
      cOpen = true;
      const bPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cPid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await applySlashCommandIntake(boss, a, inputs[0], testFeatures);
      await a.query("UPDATE agent_work_items SET status = $2 WHERE resource_key = $1", [
        resourceKey,
        status,
      ]);
      const before = await a.query<{ id: string; item: unknown }>(
        "SELECT id, to_jsonb(w) AS item FROM agent_work_items w WHERE resource_key = $1",
        [resourceKey],
      );
      winnerId = before.rows[0].id;
      const progressBefore = await a.query(
        "SELECT to_jsonb(p) AS item FROM publish_records p WHERE resource_key = $1",
        [resourceKey],
      );
      intake = applySlashCommandIntake(boss, b, inputs[1], testFeatures);
      void intake.catch(() => undefined);
      await expect
        .poll(
          async () =>
            (
              await observer.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
                bPid,
              ])
            ).rows[0].blocked,
        )
        .toBe(true);
      await a.query("COMMIT");
      aOpen = false;
      await expect.poll(() => inserted).toBe(true);
      expect(
        (
          await query("SELECT id, to_jsonb(w) AS item FROM agent_work_items w WHERE id = $1", [
            winnerId,
          ])
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await query("SELECT to_jsonb(p) AS item FROM publish_records p WHERE resource_key = $1", [
            resourceKey,
          ])
        ).rows,
      ).toEqual(progressBefore.rows);
      const sibling = {
        ...inputs[1],
        repo: `${repo}-sibling`,
        headers: {
          event: EVENT,
          delivery: randomUUID(),
          rawBody: Buffer.from(JSON.stringify({ repo, sibling: true })),
        },
      };
      await observer.query("BEGIN");
      try {
        await applySlashCommandIntake(boss, observer, sibling, testFeatures);
        await observer.query("COMMIT");
      } catch (error) {
        await observer.query("ROLLBACK");
        throw error;
      }
      expect(
        (
          await query("SELECT id FROM agent_work_items WHERE resource_key = $1", [
            prResourceKey(OWNER, sibling.repo, 77),
          ])
        ).rows,
      ).toHaveLength(1);
      cancellation = (async () => {
        if (type === "review") {
          await workItemRepository.cancelActiveReviews(c, resourceKey, {
            kind: "user",
            login: "alice",
          });
        } else if (type === "triage") {
          await workItemRepository.cancelActiveTriage(
            c,
            resourceKey,
            { kind: "user", login: "alice" },
            77,
          );
        } else {
          await c.query(
            "UPDATE agent_work_items SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1",
            [winnerId],
          );
        }
        await c.query("COMMIT");
        cOpen = false;
        cancelled = true;
      })();
      void cancellation.catch(() => undefined);
      await expect
        .poll(
          async () =>
            cancelled ||
            (await observer.query("SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [cPid, bPid]))
              .rows[0].blocked,
        )
        .toBe(true);
      resume();
      await intake;
      await b.query("COMMIT");
      bOpen = false;
      await cancellation;
    } finally {
      resume();
      if (aOpen) await a.query("ROLLBACK");
      await intake?.catch(() => undefined);
      if (bOpen) await b.query("ROLLBACK");
      await cancellation?.catch(() => undefined);
      if (cOpen) await c.query("ROLLBACK");
      spy.mockRestore();
      for (const client of [a, b, c]) {
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        client.release();
      }
      observer.release();
    }
    expect(
      (
        await pool.query("SELECT id, status FROM agent_work_items WHERE resource_key = $1", [
          resourceKey,
        ])
      ).rows,
    ).toEqual([
      { id: winnerId, status: type === "review" || type === "triage" ? "cancelled" : "completed" },
    ]);
    const accepted = await pool.query(
      `SELECT e.id FROM webhook_events e JOIN webhook_event_replays r ON r.webhook_event_id = e.id
       WHERE e.delivery_id = $1`,
      [inputs[1].headers.delivery],
    );
    expect(accepted.rows).toHaveLength(1);
    const acks = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).filter(
      (job) => job.data.repo === repo,
    );
    expect(acks).toHaveLength(2);
    const losingAck = acks.find((job) => job.data.delivery === inputs[1].headers.delivery)!.data;
    const expectedBody = {
      review: SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY,
      description: DESCRIPTION_ALREADY_IN_PROGRESS,
      triage: TRIAGE_ALREADY_IN_PROGRESS,
      verification: SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY,
    }[type];
    expect(losingAck.reply?.body).toBe(expectedBody);
    expect(losingAck.workItemId).toBeUndefined();
    const jobsBefore = await pool.query(
      "SELECT id FROM pgboss.job WHERE data->>'repo' = $1 OR data->>'workItemId' = $2 ORDER BY id",
      [repo, winnerId],
    );
    expect(jobsBefore.rows).toHaveLength(3);
    for (const delivery of [inputs[1].headers.delivery, randomUUID()]) {
      const replay = await inTransaction(pool, (client) =>
        applySlashCommandIntake(
          boss,
          client,
          {
            ...inputs[1],
            headers: { ...inputs[1].headers, delivery },
          },
          testFeatures,
        ),
      );
      expect(replay.some((event) => event.name === "deduped_delivery")).toBe(true);
    }
    expect(
      (
        await pool.query(
          "SELECT id FROM pgboss.job WHERE data->>'repo' = $1 OR data->>'workItemId' = $2 ORDER BY id",
          [repo, winnerId],
        )
      ).rows,
    ).toEqual(jobsBefore.rows);
    expect(
      (
        await pool.query("SELECT id FROM webhook_events WHERE delivery_id = $1", [
          inputs[1].headers.delivery,
        ])
      ).rows,
    ).toEqual(accepted.rows);
    if (type === "review") {
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo, prNumber: 77 });
      const tokenSpy = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "test-token",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      });
      const botSpy = vi
        .spyOn(appAuth, "getAppBotIdentity")
        .mockResolvedValue({ userId: 999, login: "test-bot" });
      const surfaceSpy = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      try {
        await executeAckJob(makeTestConfig(), pool, losingAck, boss);
        expect(fake.controls.replies).toEqual([
          { target: inputs[1].replyTarget, body: expectedBody },
        ]);
      } finally {
        tokenSpy.mockRestore();
        botSpy.mockRestore();
        surfaceSpy.mockRestore();
      }
    }
  });

  it("keeps the triage reply when cancellation races the resolved winner's payload read", async () => {
    const repo = `triage-winner-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 77);
    const input: SlashCommandInput = {
      ...makeDescribeInput(repo, randomUUID(), 1000),
      command: "triage",
      body: "/triage",
    };
    await inTransaction(pool, (client) =>
      applySlashCommandIntake(boss, client, input, testFeatures),
    );
    const incoming: SlashCommandInput = {
      ...input,
      headers: {
        event: EVENT,
        delivery: randomUUID(),
        rawBody: Buffer.from(JSON.stringify({ repo, inline: true })),
      },
      commentId: 1001,
      triageScope: "thread",
      threadAnchorCommentId: 1001,
      replyTarget: { kind: "inlineReviewThread", prNumber: 77, inReplyToCommentId: 1001 },
    };
    const b = await pool.connect();
    const c = await pool.connect();
    const observer = await pool.connect();
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let resolved = false;
    let cancelled = false;
    let bOpen = false;
    let cOpen = false;
    const create = workItemRepository.createTriageWorkItem;
    const spy = vi
      .spyOn(workItemRepository, "createTriageWorkItem")
      .mockImplementation(async (...args) => {
        const result = await create(...args);
        resolved = true;
        await gate;
        return result;
      });
    let intake: ReturnType<typeof applySlashCommandIntake> | undefined;
    let cancellation: Promise<void> | undefined;
    try {
      for (const client of [b, c]) {
        await client.query("SET lock_timeout = '10s'");
        await client.query("SET statement_timeout = '15s'");
      }
      await b.query("BEGIN");
      bOpen = true;
      await c.query("BEGIN");
      cOpen = true;
      const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cPid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      intake = applySlashCommandIntake(boss, b, incoming, testFeatures);
      void intake.catch(() => undefined);
      await expect.poll(() => resolved).toBe(true);
      cancellation = (async () => {
        await workItemRepository.cancelActiveTriage(
          c,
          resourceKey,
          { kind: "user", login: "alice" },
          77,
        );
        await c.query("COMMIT");
        cOpen = false;
        cancelled = true;
      })();
      void cancellation.catch(() => undefined);
      await expect
        .poll(
          async () =>
            cancelled ||
            (await observer.query("SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [cPid, bPid]))
              .rows[0].blocked,
        )
        .toBe(true);
      resume();
      await intake;
      await b.query("COMMIT");
      bOpen = false;
      await cancellation;
    } finally {
      resume();
      await intake?.catch(() => undefined);
      if (bOpen) await b.query("ROLLBACK");
      await cancellation?.catch(() => undefined);
      if (cOpen) await c.query("ROLLBACK");
      spy.mockRestore();
      for (const client of [b, c]) {
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        client.release();
      }
      observer.release();
    }
    expect(
      (
        await pool.query(
          `SELECT e.id FROM webhook_events e JOIN webhook_event_replays r ON r.webhook_event_id = e.id
       WHERE e.delivery_id = $1`,
          [incoming.headers.delivery],
        )
      ).rows,
    ).toHaveLength(1);
    const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).find(
      (job) => job.data.delivery === incoming.headers.delivery,
    )!.data;
    expect(ack.reply).toEqual({ target: incoming.replyTarget, body: TRIAGE_FULL_RUN_IN_PROGRESS });
    const jobs = await boss.findJobs<{ workItemId: string }>(TRIAGE_QUEUE, {});
    const work = await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [
      resourceKey,
    ]);
    expect(work.rows).toHaveLength(1);
    expect(jobs.filter((job) => job.data.workItemId === work.rows[0].id)).toHaveLength(1);
    const fake = prSurface.createFakePrSurface({ owner: OWNER, repo, prNumber: 77 });
    const tokenSpy = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
      token: "test-token",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
    });
    const botSpy = vi
      .spyOn(appAuth, "getAppBotIdentity")
      .mockResolvedValue({ userId: 999, login: "test-bot" });
    const surfaceSpy = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
    try {
      await executeAckJob(makeTestConfig(), pool, ack, boss);
      expect(fake.controls.replies).toEqual([
        { target: incoming.replyTarget, body: TRIAGE_FULL_RUN_IN_PROGRESS },
      ]);
    } finally {
      tokenSpy.mockRestore();
      botSpy.mockRestore();
      surfaceSpy.mockRestore();
    }
  });

  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((type) =>
      [false, true].map((wait) => ({ type, wait })),
    ),
  )("creates fresh $type work after a terminal winner (wait=$wait)", async ({ type, wait }) => {
    const repo = `terminal-first-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 77);
    const command = type === "description" ? "describe" : type === "verification" ? "verify" : type;
    const predecessor: SlashCommandInput = {
      ...makeDescribeInput(repo, randomUUID(), 1000),
      command,
      body: `/${command}`,
    };
    const incoming: SlashCommandInput = {
      ...predecessor,
      commentId: 1001,
      headers: {
        event: EVENT,
        delivery: randomUUID(),
        rawBody: Buffer.from(JSON.stringify({ repo, incoming: true })),
      },
    };
    const b = await pool.connect();
    const c = await pool.connect();
    const observer = await pool.connect();
    let paused = false;
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const query = b.query.bind(b);
    const spy = vi.spyOn(b, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
      if (
        type === "verification" &&
        sql.includes("SELECT id") &&
        sql.includes("type = 'verification'")
      ) {
        const result = await query<{ id: string }>(sql, values);
        expect(result.rows).toHaveLength(0);
        paused = true;
        await gate;
        return result;
      }
      if (type !== "verification" && sql.includes("INSERT INTO agent_work_items")) {
        paused = true;
        await gate;
      }
      return query(sql, values);
    });
    let intake: ReturnType<typeof applySlashCommandIntake> | undefined;
    let bOpen = false;
    let cOpen = false;
    let predecessorId = "";
    try {
      for (const client of [b, c]) {
        await client.query("SET lock_timeout = '10s'");
        await client.query("SET statement_timeout = '15s'");
      }
      if (type !== "verification") {
        await inTransaction(pool, (client) =>
          applySlashCommandIntake(boss, client, predecessor, testFeatures),
        );
      }
      await b.query("BEGIN");
      bOpen = true;
      const bPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cPid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      intake = applySlashCommandIntake(boss, b, incoming, testFeatures);
      void intake.catch(() => undefined);
      await expect.poll(() => paused).toBe(true);
      if (type === "verification") {
        await inTransaction(pool, (client) =>
          applySlashCommandIntake(boss, client, predecessor, testFeatures),
        );
      }
      predecessorId = (
        await observer.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [
          resourceKey,
        ])
      ).rows[0].id;
      await c.query("BEGIN");
      cOpen = true;
      if (type === "review") {
        await workItemRepository.cancelActiveReviews(c, resourceKey, {
          kind: "user",
          login: "alice",
        });
      } else if (type === "triage") {
        await workItemRepository.cancelActiveTriage(
          c,
          resourceKey,
          { kind: "user", login: "alice" },
          77,
        );
      } else {
        await c.query(
          "UPDATE agent_work_items SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1",
          [predecessorId],
        );
      }
      if (wait) {
        resume();
        await expect
          .poll(
            async () =>
              (
                await observer.query("SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [
                  bPid,
                  cPid,
                ])
              ).rows[0].blocked,
          )
          .toBe(true);
      }
      await c.query("COMMIT");
      cOpen = false;
      resume();
      await intake;
      await b.query("COMMIT");
      bOpen = false;
    } finally {
      resume();
      if (cOpen) await c.query("ROLLBACK");
      await intake?.catch(() => undefined);
      if (bOpen) await b.query("ROLLBACK");
      spy.mockRestore();
      for (const client of [b, c]) {
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        client.release();
      }
      observer.release();
    }
    const items = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM agent_work_items WHERE resource_key = $1",
      [resourceKey],
    );
    expect(items.rows).toHaveLength(2);
    expect(items.rows.find((item) => item.id === predecessorId)?.status).toBe(
      type === "review" || type === "triage" ? "cancelled" : "completed",
    );
    const fresh = items.rows.find((item) => item.id !== predecessorId)!;
    expect(fresh.status).toBe("queued");
    expect(
      (
        await pool.query(
          `SELECT e.id FROM webhook_events e JOIN webhook_event_replays r ON r.webhook_event_id = e.id
       WHERE e.delivery_id = $1`,
          [incoming.headers.delivery],
        )
      ).rows,
    ).toHaveLength(1);
    const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).find(
      (job) => job.data.delivery === incoming.headers.delivery,
    )!.data;
    expect(ack.workItemId).toBe(fresh.id);
    const queue = {
      review: REVIEW_QUEUE,
      description: DESCRIPTION_QUEUE,
      triage: TRIAGE_QUEUE,
      verification: VERIFICATION_QUEUE,
    }[type];
    expect(
      (await boss.findJobs<{ workItemId: string }>(queue, {})).filter(
        (job) => job.data.workItemId === fresh.id,
      ),
    ).toHaveLength(1);
  });

  it("rolls back a resolved duplicate when its ack send fails and retries normally", async () => {
    const repo = `winner-rollback-${randomUUID().slice(0, 8)}`;
    const first = makeDescribeInput(repo, randomUUID(), 1000);
    await inTransaction(pool, (client) =>
      applySlashCommandIntake(boss, client, first, testFeatures),
    );
    const incoming = makeDescribeInput(repo, randomUUID(), 1001);
    const resourceKey = prResourceKey(OWNER, repo, 77);
    const before = await pool.query(
      "SELECT to_jsonb(w) AS item FROM agent_work_items w WHERE resource_key = $1",
      [resourceKey],
    );
    const jobsBefore = await pool.query("SELECT id FROM pgboss.job ORDER BY id");
    const send = boss.send.bind(boss);
    const spy = vi
      .spyOn(boss, "send")
      .mockImplementation(async (...args: Parameters<typeof boss.send>) => {
        const id = await send(...args);
        throw new Error(`test ack failure after durable send ${id != null}`);
      });
    try {
      await expect(
        inTransaction(pool, (client) =>
          applySlashCommandIntake(boss, client, incoming, testFeatures),
        ),
      ).rejects.toThrow("test ack failure after durable send");
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(w) AS item FROM agent_work_items w WHERE resource_key = $1",
          [resourceKey],
        )
      ).rows,
    ).toEqual(before.rows);
    expect((await pool.query("SELECT id FROM pgboss.job ORDER BY id")).rows).toEqual(
      jobsBefore.rows,
    );
    expect(
      (
        await pool.query("SELECT id FROM webhook_events WHERE delivery_id = $1", [
          incoming.headers.delivery,
        ])
      ).rows,
    ).toHaveLength(0);
    const fingerprint = createHash("sha256").update(incoming.headers.rawBody).digest("hex");
    expect(
      (
        await pool.query(
          "SELECT webhook_event_id FROM webhook_event_replays WHERE body_sha256 = $1",
          [fingerprint],
        )
      ).rows,
    ).toHaveLength(0);
    await inTransaction(pool, (client) =>
      applySlashCommandIntake(boss, client, incoming, testFeatures),
    );
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(w) AS item FROM agent_work_items w WHERE resource_key = $1",
          [resourceKey],
        )
      ).rows,
    ).toEqual(before.rows);
    const ack = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).find(
      (job) => job.data.delivery === incoming.headers.delivery,
    )!.data;
    expect(ack.reply?.body).toBe(DESCRIPTION_ALREADY_IN_PROGRESS);
    expect(ack.workItemId).toBeUndefined();
    expect(
      (
        await pool.query(
          `SELECT e.id FROM webhook_events e JOIN webhook_event_replays r ON r.webhook_event_id = e.id
       WHERE e.delivery_id = $1`,
          [incoming.headers.delivery],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("concurrent same-scope /describe deliveries create one work item and one work job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const deliveries = ["d-a", "d-b", "d-c"] as const;

    await Promise.all(
      deliveries.map((delivery, index) =>
        inTransaction(pool, (client) =>
          applySlashCommandIntake(
            boss,
            client,
            makeDescribeInput(repo, delivery, 1000 + index),
            testFeatures,
          ),
        ),
      ),
    );

    const resourceKey = prResourceKey(OWNER, repo, 77);
    const workItems = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND source = 'slash'`,
      [resourceKey],
    );
    expect(workItems.rows).toHaveLength(1);
    expect(workItems.rows[0]?.status).toBe("queued");

    const descriptionJobs = await boss.findJobs(DESCRIPTION_QUEUE, {});
    const matching = descriptionJobs.filter(
      (job) => (job.data as { workItemId?: string }).workItemId === workItems.rows[0]?.id,
    );
    expect(matching).toHaveLength(1);

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ackForResource = ackJobs.filter(
      (job) =>
        (job.data as { owner?: string; repo?: string; prNumber?: number }).owner === OWNER &&
        (job.data as { repo?: string }).repo === repo &&
        (job.data as { prNumber?: number }).prNumber === 77,
    );
    expect(ackForResource.length).toBeGreaterThanOrEqual(1);
    const winnerAcks = ackForResource.filter(
      (job) => (job.data as { workItemId?: string }).workItemId === workItems.rows[0]?.id,
    );
    const loserAcks = ackForResource.filter(
      (job) =>
        (job.data as { workItemId?: string }).workItemId == null &&
        (job.data as { reply?: { body?: string } }).reply?.body?.includes("already"),
    );
    expect(winnerAcks).toHaveLength(1);
    expect(loserAcks.length).toBe(ackForResource.length - 1);
  });

  it("concurrent /verify deliveries create one work item and one work job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const deliveries = ["v-a", "v-b", "v-c"] as const;

    await Promise.all(
      deliveries.map((delivery, index) =>
        inTransaction(pool, (client) =>
          applySlashCommandIntake(
            boss,
            client,
            makeVerifyInput(repo, delivery, 2000 + index),
            testFeatures,
          ),
        ),
      ),
    );

    const resourceKey = prResourceKey(OWNER, repo, 78);
    const workItems = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'verification' AND source = 'slash'`,
      [resourceKey],
    );
    expect(workItems.rows).toHaveLength(1);
    expect(workItems.rows[0]?.status).toBe("queued");

    const matching = await verificationJobFor(boss, workItems.rows[0]?.id ?? "");
    expect(matching?.state).toBe("created");

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ackForResource = ackJobs.filter(
      (job) =>
        (job.data as { owner?: string; repo?: string; prNumber?: number }).owner === OWNER &&
        (job.data as { repo?: string }).repo === repo &&
        (job.data as { prNumber?: number }).prNumber === 78,
    );
    expect(ackForResource.length).toBeGreaterThanOrEqual(1);
    const winnerAcks = ackForResource.filter(
      (job) => (job.data as { workItemId?: string }).workItemId === workItems.rows[0]?.id,
    );
    const loserAcks = ackForResource.filter(
      (job) =>
        (job.data as { workItemId?: string }).workItemId == null &&
        (job.data as { reply?: { body?: string } }).reply?.body?.includes("already"),
    );
    expect(winnerAcks).toHaveLength(1);
    expect(loserAcks.length).toBe(ackForResource.length - 1);
  });

  it("slash /review enqueues a fresh review beside a failed prior job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 55);
    const webhookEventId = randomUUID();
    const failedWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `failed-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload, completed_at
       ) VALUES (
         $1, $2, 'review', 'auto', 'failed', $3, $4, 55, 4242, 'sha-old', 'review', $5, 0,
         '{}'::jsonb, now()
       )`,
      [failedWorkItemId, webhookEventId, OWNER, repo, resourceKey],
    );

    const failedJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: failedWorkItemId },
      { id: failedWorkItemId },
    );
    expect(failedJobId).toBeTruthy();
    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      failedJobId,
    ]);

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `slash-clear-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 55,
          commentId: 5500,
          commenterId: 11,
          body: "/review",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 55 },
        },
        testFeatures,
      ),
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND status = 'queued'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(1);
    const newWorkItemId = rows[0]?.id;
    expect(newWorkItemId).toBeTruthy();

    const replacementJob = await reviewJobFor(boss, newWorkItemId);
    expect(replacementJob?.state).toBe("created");
    const failedJob = await boss.getJobById(REVIEW_QUEUE, failedJobId!);
    expect(failedJob?.state).toBe("failed");
  });

  it("/review force cancels the active review and enqueues a replacement in one tx", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 44);
    const webhookEventId = randomUUID();
    const oldWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `force-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 44, 4242, 'sha-old', 'review', $5, 0,
         '{}'::jsonb
       )`,
      [oldWorkItemId, webhookEventId, OWNER, repo, resourceKey],
    );
    const oldJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: oldWorkItemId },
      { id: oldWorkItemId },
    );
    expect(oldJobId).toBeTruthy();

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `force-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 44,
          commentId: 4400,
          commenterId: 11,
          commenterLogin: "alice",
          body: "/review force",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 44 },
        },
        testFeatures,
      ),
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(2);
    const newRow = rows.find((row) => row.id !== oldWorkItemId);
    expect(rows).toEqual(expect.arrayContaining([{ id: oldWorkItemId, status: "cancelled" }]));
    expect(newRow?.status).toBe("queued");

    const oldJob = await boss.getJobById(REVIEW_QUEUE, oldJobId!);
    expect(oldJob?.state).toBe("created");
    const replacementJob = await reviewJobFor(boss, newRow!.id);
    expect(replacementJob?.state).toBe("created");

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ack = ackJobs.find(
      (job) => (job.data as { workItemId?: string }).workItemId === newRow?.id,
    );
    const ackData = ack?.data as {
      progress?: unknown;
      cancelProgress?: { workItemId: string; cancelledWorkItemIds: readonly string[] };
      reply?: { body: string };
    };
    expect(ackData.progress).toBeTruthy();
    expect(ackData.cancelProgress?.workItemId).toBe(oldWorkItemId);
    expect(ackData.cancelProgress?.cancelledWorkItemIds).toEqual([oldWorkItemId]);
    expect(ackData.reply?.body).toContain("latest commit");
  });

  it.each([
    { prior: "empty", first: "/review force", second: "/review force" },
    { prior: "queued", first: "/review force", second: "/review force" },
    { prior: "running", first: "/review force", second: "/review force" },
    { prior: "empty", first: "/review", second: "/review force" },
    { prior: "empty", first: "/review force", second: "/review" },
  ])(
    "serializes $first then $second with a $prior predecessor",
    async ({ prior, first, second }) => {
      const repo = `race-${randomUUID().slice(0, 8)}`;
      const resourceKey = prResourceKey(OWNER, repo, 44);
      const priorId = randomUUID();
      if (prior !== "empty") {
        await pool.query(
          `INSERT INTO agent_work_items (
           id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, review_lens, resource_key, payload
         ) VALUES ($1, 'review', 'slash', $2, $3, $4, 44, 4242, 'old-head',
                   'review', $5, '{"mode":"review","source":"slash"}')`,
          [priorId, prior, OWNER, repo, resourceKey],
        );
      }
      const inputs: SlashCommandInput[] = [first, second].map((body, index) => ({
        headers: {
          event: EVENT,
          delivery: `${repo}-${index}`,
          rawBody: Buffer.from(JSON.stringify({ repo, commentId: 4400 + index, body })),
        },
        installationId: 4242,
        owner: OWNER,
        repo,
        prNumber: 44,
        commentId: 4400 + index,
        commenterId: 11 + index,
        commenterLogin: index === 0 ? "alice" : "bob",
        body,
        command: "review",
        replyTarget: { kind: "prConversation", prNumber: 44 },
      }));
      const a = await pool.connect();
      const b = await pool.connect();
      const observer = await pool.connect();
      let aOpen = false;
      let bOpen = false;
      let pending: ReturnType<typeof applySlashCommandIntake> | undefined;
      let firstId = "";
      try {
        await a.query("BEGIN");
        aOpen = true;
        await b.query("BEGIN");
        bOpen = true;
        const { rows: pids } = await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await applySlashCommandIntake(boss, a, inputs[0], testFeatures);
        const { rows: staged } = await a.query<{ id: string }>(
          "SELECT id FROM agent_work_items WHERE resource_key = $1 AND status = 'queued'",
          [resourceKey],
        );
        firstId = staged[0].id;
        pending = applySlashCommandIntake(boss, b, inputs[1], testFeatures);
        void pending.catch(() => undefined);
        await expect
          .poll(async () => {
            const { rows } = await observer.query<{ blocked: boolean }>(
              "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
              [pids[0].pid],
            );
            return rows[0]?.blocked;
          })
          .toBe(true);
        await a.query("COMMIT");
        aOpen = false;
        await pending;
        await b.query("COMMIT");
        bOpen = false;
      } finally {
        if (aOpen) await a.query("ROLLBACK");
        await pending?.catch(() => undefined);
        if (bOpen) await b.query("ROLLBACK");
        a.release();
        b.release();
        observer.release();
      }

      const { rows } = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_work_items WHERE resource_key = $1 AND type = 'review'",
        [resourceKey],
      );
      const active = rows.filter((row) => row.status === "queued" || row.status === "running");
      expect(active).toHaveLength(1);
      const survivorId = active[0].id;
      const acks = (await boss.findJobs<AckJobData>(ACK_QUEUE, {}))
        .filter((job) => job.data.owner === OWNER && job.data.repo === repo)
        .map((job) => job.data);
      expect(acks).toHaveLength(2);
      const firstAck = acks.find((ack) => ack.delivery === inputs[0].headers.delivery)!;
      const secondAck = acks.find((ack) => ack.delivery === inputs[1].headers.delivery)!;
      expect(firstAck.workItemId).toBe(firstId);
      expect(firstAck.progress).toMatchObject({ lens: "review", source: "slash" });
      const reviewJobs = await boss.findJobs<{ workItemId: string }>(REVIEW_QUEUE, {});
      if (second === "/review force") {
        expect(rows.find((row) => row.id === firstId)?.status).toBe("cancelled");
        expect(survivorId).not.toBe(firstId);
        expect(secondAck.workItemId).toBe(survivorId);
        expect(secondAck.cancelProgress?.cancelledWorkItemIds).toContain(firstId);
        expect(secondAck.reply?.body).toBe(SLASH_REVIEW_FORCE_RESTARTED_BODY);
        expect(acks.some((ack) => ack.reply?.body === SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY)).toBe(
          false,
        );
        expect(
          reviewJobs.filter((job) => [firstId, survivorId].includes(job.data.workItemId)),
        ).toHaveLength(2);
      } else {
        expect(survivorId).toBe(firstId);
        expect(secondAck.workItemId).toBeUndefined();
        expect(secondAck.reply?.body).toBe(SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY);
        expect(reviewJobs.filter((job) => job.data.workItemId === firstId)).toHaveLength(1);
      }
      const { rows: progress } = await pool.query<{ work_item_id: string }>(
        `SELECT work_item_id FROM publish_records
        WHERE resource_key = $1 AND review_lens = 'review' AND step = 'progress_comment'`,
        [resourceKey],
      );
      expect(progress[0]?.work_item_id).toBe(survivorId);
      if (prior !== "empty") {
        expect(rows.find((row) => row.id === priorId)?.status).toBe("cancelled");
        expect(firstAck.cancelProgress?.cancelledWorkItemIds).toContain(priorId);
        expect(firstAck.reply?.body).toBe(SLASH_REVIEW_FORCE_RESTARTED_BODY);
      }
      if (prior === "queued") {
        const fake = prSurface.createFakePrSurface({ owner: OWNER, repo, prNumber: 44 });
        const tokenSpy = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
          token: "test-token",
          expiresAtTs: Date.now() + 3_600_000,
          ttlMs: 3_600_000,
        });
        const botSpy = vi
          .spyOn(appAuth, "getAppBotIdentity")
          .mockResolvedValue({ userId: 999, login: "test-bot" });
        const surfaceSpy = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
        try {
          await executeAckJob(makeTestConfig(), pool, firstAck, boss);
          await executeAckJob(makeTestConfig(), pool, secondAck, boss);
          expect(fake.controls.replies).toEqual([
            { target: firstAck.reply!.target, body: SLASH_REVIEW_FORCE_RESTARTED_BODY },
            { target: secondAck.reply!.target, body: SLASH_REVIEW_FORCE_RESTARTED_BODY },
          ]);
          const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
          expect(comment?.body).toContain("Review queued on the latest commit.");
          expect(parseProgressRevisionState(comment!.body)?.workItemId).toBe(survivorId);
        } finally {
          tokenSpy.mockRestore();
          botSpy.mockRestore();
          surfaceSpy.mockRestore();
        }
      }
    },
  );

  it("/review force releases the cancelled holder's lease so the sole replacement can be claimed", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 44);
    const webhookEventId = randomUUID();
    const oldWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `force-lease-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 44, 4242, 'sha-old', 'review', $5, 0,
         '{}'::jsonb
       )`,
      [oldWorkItemId, webhookEventId, OWNER, repo, resourceKey],
    );
    const heldEpoch = await acquireReviewLease(oldWorkItemId, resourceKey);
    expect(heldEpoch).toBeGreaterThan(0);
    // Mirror the production atomicClaim path, which records the acquired epoch
    // on the item row: intake cancel builds exact (id, epoch) release pairs
    // from these records (#660). Rows without a record (pre-fix) fail closed.
    await pool.query(`UPDATE agent_work_items SET execution_epoch = $2 WHERE id = $1`, [
      oldWorkItemId,
      heldEpoch,
    ]);
    const siblingWorkItemId = randomUUID();
    const siblingAcquisition = await acquirePrActorLease(pool, {
      resourceKey,
      workType: "verification",
      workItemId: siblingWorkItemId,
      holderId: "sibling-work-type",
      ttlSeconds: 900,
    });
    if (!siblingAcquisition.acquired) throw new Error("expected a sibling work-type lease");
    const siblingEpoch = siblingAcquisition.leaseEpoch;
    await expect(
      acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: randomUUID(),
        holderId: "blocked-before-force",
        ttlSeconds: 900,
      }),
    ).resolves.toEqual({
      acquired: false,
      heldByWorkItemId: oldWorkItemId,
      leaseEpoch: heldEpoch,
    });

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `force-lease-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 44,
          commentId: 4401,
          commenterId: 11,
          commenterLogin: "alice",
          body: "/review force",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 44 },
        },
        testFeatures,
      ),
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'`,
      [resourceKey],
    );
    const newRow = rows.find((row) => row.id !== oldWorkItemId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: oldWorkItemId, status: "cancelled" },
        { id: newRow?.id, status: "queued" },
      ]),
    );
    expect(newRow).toBeDefined();
    await expect(getReviewQueuePosition(pool, newRow!.id)).resolves.toEqual({
      position: 1,
      total: 1,
    });
    await expect(isPrActorLeaseHeld(pool, oldWorkItemId, heldEpoch)).resolves.toBe(false);
    await expect(assertPrActorLeaseHeld(pool, oldWorkItemId, heldEpoch)).rejects.toMatchObject({
      code: "agent_work.pr_actor_lease_lost",
    });
    await expect(isPrActorLeaseHeld(pool, siblingWorkItemId, siblingEpoch)).resolves.toBe(true);

    const admission = await acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId: newRow!.id,
      holderId: "replacement-after-force",
      ttlSeconds: 900,
    });
    expect(admission).toEqual({ acquired: true, leaseEpoch: heldEpoch + 1 });
    await expect(isPrActorLeaseHeld(pool, newRow!.id, heldEpoch + 1)).resolves.toBe(true);
    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: oldWorkItemId,
        leaseEpoch: heldEpoch,
        ttlSeconds: 900,
      }),
    ).resolves.toBe(false);
    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: newRow!.id,
        leaseEpoch: heldEpoch + 1,
        ttlSeconds: 900,
      }),
    ).resolves.toBe(true);
    await expect(claimWorkForExecution(pool, newRow!.id)).resolves.toEqual(
      expect.objectContaining({ attemptCount: 0 }),
    );
    await expect(getReviewQueuePosition(pool, newRow!.id)).resolves.toBeNull();
  });

  it("rolls back a forced replacement and retries without duplicating delivery work", async () => {
    const repo = `rollback-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 44);
    const input: SlashCommandInput = {
      headers: {
        event: EVENT,
        delivery: randomUUID(),
        rawBody: Buffer.from(JSON.stringify({ repo, body: "/review" })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 44,
      commentId: 4400,
      commenterId: 11,
      body: "/review",
      command: "review",
      replyTarget: { kind: "prConversation", prNumber: 44 },
    };
    await inTransaction(pool, (client) =>
      applySlashCommandIntake(boss, client, input, testFeatures),
    );
    const predecessor = (
      await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_work_items WHERE resource_key = $1",
        [resourceKey],
      )
    ).rows[0];
    const forcedHeaders = {
      event: EVENT,
      delivery: randomUUID(),
      rawBody: Buffer.from(JSON.stringify({ repo, body: "/review force" })),
    };
    const forcedInput: SlashCommandInput = {
      ...input,
      headers: forcedHeaders,
      commentId: 4401,
      body: "/review force",
    };
    const initialAckIds = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).map((job) => job.id);
    const initialReviewIds = (await boss.findJobs(REVIEW_QUEUE, {})).map((job) => job.id);

    await expect(
      inTransaction(pool, async (client) => {
        await applySlashCommandIntake(boss, client, forcedInput, testFeatures);
        throw new Error("injected failure after enqueue");
      }),
    ).rejects.toThrow("injected failure after enqueue");
    const rolledBackWork = await pool.query(
      "SELECT id, status FROM agent_work_items WHERE resource_key = $1",
      [resourceKey],
    );
    expect(rolledBackWork.rows).toEqual([predecessor]);
    expect((await boss.findJobs(ACK_QUEUE, {})).map((job) => job.id).toSorted()).toEqual(
      initialAckIds.toSorted(),
    );
    expect((await boss.findJobs(REVIEW_QUEUE, {})).map((job) => job.id).toSorted()).toEqual(
      initialReviewIds.toSorted(),
    );
    const rolledBackDelivery = await pool.query(
      "SELECT id FROM webhook_events WHERE delivery_id = $1",
      [forcedHeaders.delivery],
    );
    expect(rolledBackDelivery.rows).toEqual([]);
    const rolledBackReplay = await pool.query(
      "SELECT body_sha256 FROM webhook_event_replays WHERE body_sha256 = $1",
      [createHash("sha256").update(forcedHeaders.rawBody).digest("hex")],
    );
    expect(rolledBackReplay.rows).toEqual([]);
    const rolledBackOwner = await pool.query<{ work_item_id: string }>(
      "SELECT work_item_id FROM publish_records WHERE resource_key = $1 AND step = 'progress_comment'",
      [resourceKey],
    );
    expect(rolledBackOwner.rows[0]?.work_item_id).toBe(predecessor.id);

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(boss, client, forcedInput, testFeatures),
    );
    const committedRows = (
      await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_work_items WHERE resource_key = $1 ORDER BY id",
        [resourceKey],
      )
    ).rows;
    expect(committedRows.find((row) => row.id === predecessor.id)?.status).toBe("cancelled");
    const replacement = committedRows.filter((row) => row.status === "queued");
    expect(replacement).toHaveLength(1);
    const retryAckIds = (await boss.findJobs<AckJobData>(ACK_QUEUE, {})).map((job) => job.id);
    const retryReviewIds = (await boss.findJobs(REVIEW_QUEUE, {})).map((job) => job.id);
    for (const delivery of [forcedHeaders.delivery, randomUUID()]) {
      const replay = await inTransaction(pool, (client) =>
        applySlashCommandIntake(
          boss,
          client,
          {
            ...forcedInput,
            headers: { ...forcedHeaders, delivery },
          },
          testFeatures,
        ),
      );
      expect(replay.some((event) => event.name === "deduped_delivery")).toBe(true);
      const replayRows = await pool.query(
        "SELECT id, status FROM agent_work_items WHERE resource_key = $1 ORDER BY id",
        [resourceKey],
      );
      expect(replayRows.rows).toEqual(committedRows);
      expect((await boss.findJobs(ACK_QUEUE, {})).map((job) => job.id).toSorted()).toEqual(
        retryAckIds.toSorted(),
      );
      expect((await boss.findJobs(REVIEW_QUEUE, {})).map((job) => job.id).toSorted()).toEqual(
        retryReviewIds.toSorted(),
      );
    }
  });

  it("/review force leaves a sibling PR's active review untouched", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const key44 = prResourceKey(OWNER, repo, 44);
    const key45 = prResourceKey(OWNER, repo, 45);
    const webhookEventId = randomUUID();
    const oldWorkItemId = randomUUID();
    const siblingWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `force-iso-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
         ($1, $2, 'review', 'slash', 'running', $3, $4, 44, 4242, 'sha-old', 'review', $5, 0,
           '{}'::jsonb),
         ($6, $2, 'review', 'slash', 'running', $3, $4, 45, 4242, 'sha-sib', 'review', $7, 0,
           '{}'::jsonb)`,
      [oldWorkItemId, webhookEventId, OWNER, repo, key44, siblingWorkItemId, key45],
    );
    const oldJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: oldWorkItemId },
      { id: oldWorkItemId },
    );
    const siblingJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: siblingWorkItemId },
      { id: siblingWorkItemId },
    );
    expect(oldJobId).toBeTruthy();
    expect(siblingJobId).toBeTruthy();

    const input: SlashCommandInput = {
      headers: {
        event: EVENT,
        delivery: `force-iso-${randomUUID().slice(0, 8)}`,
        rawBody: Buffer.from(JSON.stringify({ repo, prNumber: 44 })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 44,
      commentId: 4401,
      commenterId: 11,
      commenterLogin: "alice",
      body: "/review force",
      command: "review",
      replyTarget: { kind: "prConversation", prNumber: 44 },
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applySlashCommandIntake(boss, client, input, testFeatures);
      // Another PR's force commits while this PR still holds its intake lock.
      await inTransaction(pool, (otherClient) =>
        applySlashCommandIntake(
          boss,
          otherClient,
          {
            ...input,
            headers: {
              ...input.headers,
              delivery: randomUUID(),
              rawBody: Buffer.from(JSON.stringify({ repo, prNumber: 46 })),
            },
            prNumber: 46,
            commentId: 4601,
            replyTarget: { kind: "prConversation", prNumber: 46 },
          },
          testFeatures,
        ),
      );
      const independent = await pool.query<{ status: string }>(
        "SELECT status FROM agent_work_items WHERE resource_key = $1",
        [prResourceKey(OWNER, repo, 46)],
      );
      expect(independent.rows).toEqual([{ status: "queued" }]);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const { rows: rows44 } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'`,
      [key44],
    );
    expect(rows44).toHaveLength(2);
    const newRow = rows44.find((row) => row.id !== oldWorkItemId);
    expect(rows44).toEqual(expect.arrayContaining([{ id: oldWorkItemId, status: "cancelled" }]));
    expect(newRow?.status).toBe("queued");

    const { rows: rows45 } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items WHERE id = $1`,
      [siblingWorkItemId],
    );
    expect(rows45).toEqual([{ id: siblingWorkItemId, status: "running" }]);

    const oldJob = await boss.getJobById(REVIEW_QUEUE, oldJobId!);
    expect(oldJob?.state).toBe("created");
    const siblingJob = await boss.getJobById(REVIEW_QUEUE, siblingJobId!);
    expect(siblingJob?.state).toBe("created");

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ack = ackJobs.find(
      (job) => (job.data as { workItemId?: string }).workItemId === newRow?.id,
    );
    const ackData = ack?.data as {
      cancelProgress?: { workItemId: string; cancelledWorkItemIds: readonly string[] };
    };
    expect(ackData.cancelProgress?.cancelledWorkItemIds).toEqual([oldWorkItemId]);
  });

  it("keeps one review when a removed lens command arrives concurrently", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const lenses = ["review", "review-security"] as const;

    await Promise.all(
      lenses.map((lens, index) =>
        inTransaction(pool, (client) =>
          applySlashCommandIntake(
            boss,
            client,
            {
              headers: {
                event: EVENT,
                delivery: `lens-${lens}`,
                rawBody: Buffer.from(JSON.stringify({ command: lens })),
              },
              installationId: 4242,
              owner: OWNER,
              repo,
              prNumber: 88,
              commentId: 2000 + index,
              commenterId: 11,
              body: `/${lens}`,
              command: lens,
              replyTarget: { kind: "prConversation" as const, prNumber: 88 },
            },
            testFeatures,
          ),
        ),
      ),
    );

    const resourceKey = prResourceKey(OWNER, repo, 88);
    const { rows } = await pool.query<{ review_lens: string }>(
      `SELECT review_lens FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash' AND status = 'queued'
        ORDER BY review_lens`,
      [resourceKey],
    );
    expect(rows.map((r) => r.review_lens)).toEqual(["review"]);
  });

  it("does not uniqueness-block auto description inserts beside active slash work", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 99);
    const webhookEventId = randomUUID();
    const slashId = randomUUID();
    const autoId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `auto-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'description', 'slash', 'queued', $3, $4, 99, 4242, 'sha-slash', $5, 50, '{}'::jsonb
       )`,
      [slashId, webhookEventId, OWNER, repo, resourceKey],
    );

    await expect(
      pool.query(
        `INSERT INTO agent_work_items (
           id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, resource_key, priority, payload
         ) VALUES (
           $1, $2, 'description', 'auto', 'queued', $3, $4, 99, 4242, 'sha-auto', $5, 0, '{}'::jsonb
         )`,
        [autoId, webhookEventId, OWNER, repo, resourceKey],
      ),
    ).resolves.toBeTruthy();

    const { rows } = await pool.query<{ id: string; source: string }>(
      `SELECT id, source FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND status = 'queued'
        ORDER BY source`,
      [resourceKey],
    );
    expect(rows).toEqual([
      { id: autoId, source: "auto" },
      { id: slashId, source: "slash" },
    ]);
  });

  it("allows a staleHeadRescheduled replacement while the parent remains running", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 66);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `parent-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 66, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        parentId,
        webhookEventId,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    await expect(
      pool.query(
        `INSERT INTO agent_work_items (
           id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, review_lens, resource_key, priority, payload
         ) VALUES (
           $1, $2, 'review', 'slash', 'queued', $3, $4, 66, 4242, 'sha-new', 'review', $5, 0,
           $6::jsonb
         )`,
        [
          replacementId,
          webhookEventId,
          OWNER,
          repo,
          resourceKey,
          JSON.stringify({
            mode: "review",
            source: "slash",
            staleHeadRescheduled: true,
            staleHeadReplacementWorkItemId: replacementId,
          }),
        ],
      ),
    ).resolves.toBeTruthy();

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'
        ORDER BY status`,
      [resourceKey],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: parentId, status: "running" },
        { id: replacementId, status: "queued" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("atomically reuses stale-head review and ack jobs", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 57);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `reschedule-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
       ($1, $2, 'review', 'slash', 'running', $3, $4, 57, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb),
       ($7, $2, 'review', 'slash', 'queued', $3, $4, 57, 4242, 'sha-new', 'review', $5, 0,
         $8::jsonb)`,
      [
        parentId,
        webhookEventId,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
        replacementId,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );
    const parent = makeReviewWorkItem({
      id: parentId,
      webhookEventId,
      owner: OWNER,
      repo,
      prNumber: 57,
      installationId: 4242,
      headSha: "sha-old",
      resourceKey,
      source: "slash",
      payload: {
        staleHeadReplacement: {
          replacementWorkItemId: replacementId,
          state: "pending-enqueue",
        },
      },
    });
    const leaseEpoch = await acquireReviewLease(parentId, resourceKey);

    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new", leaseEpoch);
    await boss.complete(REVIEW_QUEUE, replacementId, null, { includeQueued: true });
    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new", leaseEpoch);

    const reviewJobs = await boss.findJobs(REVIEW_QUEUE, { id: replacementId });
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]?.state).toBe("completed");
    await expect(boss.findJobs(ACK_QUEUE, { id: replacementId })).resolves.toHaveLength(1);
    const { rows } = await pool.query<{
      state: string | null;
      replacement_id: string | null;
      legacy_enqueued: string | null;
    }>(
      `SELECT payload->'staleHeadReplacement'->>'state' AS state,
              COALESCE(
                payload->'staleHeadReplacement'->>'replacementWorkItemId',
                payload->>'staleHeadReplacementWorkItemId'
              ) AS replacement_id,
              payload->>'staleHeadReplacementEnqueued' AS legacy_enqueued
         FROM agent_work_items
        WHERE id = $1`,
      [parentId],
    );
    expect(rows).toEqual([
      { state: "enqueued", replacement_id: replacementId, legacy_enqueued: null },
    ]);
  });

  it("recovers a persisted-but-unenqueued replacement without duplicating or orphaning", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 58);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `crash-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 58, 4242, 'sha-old', 'review', $5, 0,
         '{"mode":"review","source":"slash"}'::jsonb
       )`,
      [parentId, webhookEventId, OWNER, repo, resourceKey],
    );

    const parent = await getWorkItem(pool, parentId);
    expect(parent?.type).toBe("review");
    if (parent?.type !== "review") throw new Error("expected review parent");
    const leaseEpoch = await acquireReviewLease(parentId, resourceKey);

    const first = await createReviewRescheduleWorkItem(pool, parent, leaseEpoch);
    const second = await createReviewRescheduleWorkItem(
      pool,
      {
        ...parent,
        payload: {
          ...parent.payload,
          staleHeadReplacement: {
            replacementWorkItemId: first.replacementWorkItemId,
            state: "pending-enqueue",
          },
        },
      },
      leaseEpoch,
    );
    expect(second.replacementWorkItemId).toBe(first.replacementWorkItemId);

    const persisted = await getWorkItem(pool, parentId);
    expect(persisted?.type).toBe("review");
    if (persisted?.type !== "review") throw new Error("expected review parent");
    expect(persisted.payload.staleHeadReplacement).toEqual({
      replacementWorkItemId: first.replacementWorkItemId,
      state: "pending-enqueue",
    });

    const { rows: replacements } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND id <> $2`,
      [resourceKey, parentId],
    );
    expect(replacements).toEqual([{ id: first.replacementWorkItemId, status: "queued" }]);

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      persisted,
      new Error("parent terminal before enqueue"),
    );

    const { rows: afterCancel } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND id <> $2`,
      [resourceKey, parentId],
    );
    expect(afterCancel).toEqual([{ id: first.replacementWorkItemId, status: "cancelled" }]);
    await expect(boss.findJobs(REVIEW_QUEUE, { id: first.replacementWorkItemId })).resolves.toEqual(
      [],
    );
  });

  it("migration cleanup cancels non-replacement duplicates and preserves a replacement pair", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 55);
    const webhookEventId = randomUUID();
    const keepId = randomUUID();
    const dupId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `cleanup-${webhookEventId}`, EVENT],
    );

    await pool.query(`DROP INDEX IF EXISTS agent_work_items_slash_active_uniqueness_idx`);

    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, priority, payload, created_at
       ) VALUES
       ($1, $2, 'description', 'slash', 'running', $3, $4, 55, 4242, 'sha', $5, 50, '{}'::jsonb, now() - interval '2 minutes'),
       ($6, $2, 'description', 'slash', 'queued', $3, $4, 55, 4242, 'sha', $5, 50, '{}'::jsonb, now() - interval '1 minute')`,
      [keepId, webhookEventId, OWNER, repo, resourceKey, dupId],
    );

    const reviewKey = prResourceKey(OWNER, repo, 56);
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
       ($1, $2, 'review', 'slash', 'running', $3, $4, 56, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb),
       ($7, $2, 'review', 'slash', 'queued', $3, $4, 56, 4242, 'sha-new', 'review', $5, 0,
         $8::jsonb)`,
      [
        parentId,
        webhookEventId,
        OWNER,
        repo,
        reviewKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
        replacementId,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    const sql = await readFile(
      path.join(process.cwd(), "migrations/014_slash_active_uniqueness.sql"),
      "utf8",
    );
    await pool.query(sql);

    const descriptionRows = await pool.query<{
      id: string;
      status: string;
      last_error: string | null;
    }>(
      `SELECT id, status, last_error FROM agent_work_items WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[keepId, dupId]],
    );
    expect(descriptionRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: keepId, status: "running" }),
        expect.objectContaining({
          id: dupId,
          status: "cancelled",
          last_error: expect.stringContaining("014_slash_active_uniqueness"),
        }),
      ]),
    );

    const reviewRows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [[parentId, replacementId]],
    );
    expect(reviewRows.rows).toEqual(
      expect.arrayContaining([
        { id: parentId, status: "running" },
        { id: replacementId, status: "queued" },
      ]),
    );
  });
});
