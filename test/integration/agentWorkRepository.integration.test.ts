import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import * as closeRepository from "../../src/agentWork/publishRecordRepository.js";
import {
  closeOwnVerdict,
  closeOwnVerdictsForWorkItems,
} from "../../src/agentWork/closeOwnVerdict.js";
import { runMigrations } from "../../src/db/migrations.js";
import * as postgres from "../../src/db/postgres.js";
import * as leaseRepository from "../../src/agentWork/prActorLease.js";
import { acquirePrActorLease, releasePrActorLease } from "../../src/agentWork/prActorLease.js";
import {
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
  hasCompletedPublishStep,
  markQueuedWorkCancelled,
  markWorkCancelled,
  markWorkCompleted,
  markWorkRetrying,
  recordAskPublishStep,
  recordReviewCheckRun,
} from "../../src/agentWork/repository.js";
import type { WorkStatus } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "repo-it";

type InsertWorkItemInput = {
  readonly status?: WorkStatus;
  readonly attemptCount?: number;
  readonly cancelRequestedAt?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly resourceKey?: string;
};

type WorkRow = {
  readonly status: WorkStatus;
  readonly attempt_count: number;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly cancel_requested_at: Date | null;
  readonly last_error: string | null;
};

describe.skipIf(!hasDatabase)("agent work repository (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE 'repo-it-%'");
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
  });

  async function insertWorkItem(input: InsertWorkItemInput = {}): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, attempt_count, cancel_requested_at, payload
       )
       VALUES ($1, 'review', 'auto', $2, $3, 'r', 1, 1, 'h', 'review', $4, $5, $6, $7::jsonb)`,
      [
        id,
        input.status ?? "queued",
        OWNER,
        input.resourceKey ?? `repo-it-${id}`,
        input.attemptCount ?? 0,
        input.cancelRequestedAt ?? null,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return id;
  }

  async function insertAskWorkItem(resourceKey: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, payload
       )
       VALUES ($1, 'ask', 'slash', 'queued', $2, 'r', 1, 1, 'h', $3, $4::jsonb)`,
      [
        id,
        OWNER,
        resourceKey,
        JSON.stringify({
          question: "what changed?",
          replyTarget: { kind: "prConversation", prNumber: 1 },
          commentId: 99,
          commenterId: 123,
        }),
      ],
    );
    return id;
  }

  async function acquireReviewLease(id: string, resourceKey: string): Promise<number> {
    const acquisition = await acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId: id,
      holderId: "repo-it-holder",
      ttlSeconds: 900,
    });
    if (!acquisition.acquired) throw new Error(`expected lease acquisition for ${id}`);
    return acquisition.leaseEpoch;
  }

  async function getWorkRow(id: string): Promise<WorkRow> {
    const { rows } = await pool.query<WorkRow>(
      `SELECT status, attempt_count, started_at, completed_at, cancel_requested_at, last_error
         FROM agent_work_items
        WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error(`missing work item ${id}`);
    return row;
  }

  it("returns claim timestamps that preserve queue wait", async () => {
    const id = await insertWorkItem();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [id, createdAt]);

    const claim = await claimWorkForExecution(pool, id);
    expect(claim).not.toBeNull();
    expect(claim?.createdAt).toEqual(createdAt);
    expect(claim?.startedAt.getTime()).toBeGreaterThan(createdAt.getTime());
    expect(claim?.attemptCount).toBe(1);
    expect(claim?.resumed).toBe(false);
  });

  it("claims queued work and increments the attempt count", async () => {
    const id = await insertWorkItem();

    const claim = await claimWorkForExecution(pool, id);
    expect(claim).toEqual({
      createdAt: expect.any(Date),
      startedAt: expect.any(Date),
      attemptCount: 1,
      resumed: false,
    });

    const row = await getWorkRow(id);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(1);
    expect(row.started_at).toBeInstanceOf(Date);
    expect(claim?.startedAt).toEqual(row.started_at);
    expect(claim?.startedAt.getTime()).toBeGreaterThanOrEqual(claim?.createdAt.getTime() ?? 0);
  });

  it("counts a running-row resume as an attempt and flags it", async () => {
    const id = await insertWorkItem();

    await claimWorkForExecution(pool, id);
    await expect(claimWorkForExecution(pool, id)).resolves.toMatchObject({
      attemptCount: 2,
      resumed: true,
      createdAt: expect.any(Date),
      startedAt: expect.any(Date),
    });

    const row = await getWorkRow(id);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(2);
  });

  it("does not claim work after cancellation is requested", async () => {
    const id = await insertWorkItem({ cancelRequestedAt: new Date().toISOString() });

    await expect(claimWorkForExecution(pool, id)).resolves.toBeNull();

    const row = await getWorkRow(id);
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(0);
  });

  it("completes running work once only", async () => {
    const id = await insertWorkItem({ status: "running", attemptCount: 1 });

    await expect(markWorkCompleted(pool, id, null)).resolves.toBe(true);
    await expect(markWorkCompleted(pool, id, null)).resolves.toBe(false);

    const row = await getWorkRow(id);
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBeInstanceOf(Date);
  });

  it("prevents completion after cancellation wins", async () => {
    const id = await insertWorkItem({ status: "running", attemptCount: 1 });

    await markWorkCancelled(pool, id);

    await expect(markWorkCompleted(pool, id, null)).resolves.toBe(false);
    await expect(getWorkRow(id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it.each(["queued", "running"] as const)(
    "cancels %s replacement work idempotently without failure or lease release (#661)",
    async (status) => {
      const id = await insertWorkItem();
      const key = `repo-it-${id}`;
      const epoch = status === "running" ? await acquireReviewLease(id, key) : null;
      if (epoch != null) await claimWorkForExecution(pool, id, epoch);
      const error = new Error("parent terminal token=synthetic-secret");
      await expect(markQueuedWorkCancelled(pool, id, error)).resolves.toBe(true);
      const cancelled = await getWorkRow(id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancel_requested_at).not.toBeNull();
      expect(cancelled.last_error).toBe("parent terminal [redacted]");
      await expect(markQueuedWorkCancelled(pool, id, new Error("duplicate"))).resolves.toBe(true);
      expect(await getWorkRow(id)).toEqual(cancelled);
      await expect(claimWorkForExecution(pool, id, epoch)).resolves.toBeNull();
      await expect(markWorkCompleted(pool, id, epoch)).resolves.toBe(false);
      if (epoch != null) {
        await expect(leaseRepository.isPrActorLeaseHeld(pool, id, epoch)).resolves.toBe(true);
      }
    },
  );

  it.each(["unknown_epoch", "missing_lease"])(
    "fails closed for running replacement with %s (#661)",
    async (mode) => {
      const id = await insertWorkItem({ status: "running" });
      const epoch = await acquireReviewLease(id, `repo-it-${id}`);
      if (mode === "missing_lease") {
        await claimWorkForExecution(pool, id, epoch);
        await releasePrActorLease(pool, {
          resourceKey: `repo-it-${id}`,
          workType: "review",
          leaseEpoch: epoch,
        });
      }
      const outcome = await markQueuedWorkCancelled(pool, id, new Error("parent terminal")).catch(
        () => false,
      );
      expect(outcome).toBe(false);
      expect((await getWorkRow(id)).status).toBe("running");
    },
  );

  it.each(["same_item", "other_item", "queued_retry"])(
    "never cancels a newer replacement execution during %s (#661)",
    async (mode) => {
      const id = await insertWorkItem();
      const key = `repo-it-${id}`;
      const epoch = await acquireReviewLease(id, key);
      await claimWorkForExecution(pool, id, epoch);
      const nextId = mode === "other_item" ? await insertWorkItem({ resourceKey: key }) : id;
      const read = postgres.queryOne;
      let observed = false;
      vi.spyOn(postgres, "queryOne").mockImplementation(
        async <T extends QueryResultRow>(
          client: Pool | PoolClient,
          text: string,
          values: unknown[] = [],
        ) => {
          if (
            !observed &&
            values[0] === id &&
            text.includes("execution_epoch") &&
            text.includes("SELECT")
          ) {
            observed = true;
            if (mode === "queued_retry")
              await markWorkRetrying(pool, id, new Error("retry"), epoch);
            const result = await read<T>(client, text, values);
            await releasePrActorLease(pool, {
              resourceKey: key,
              workType: "review",
              leaseEpoch: epoch,
            });
            const next = await acquireReviewLease(nextId, key);
            expect(next).toBe(epoch + 1);
            await claimWorkForExecution(pool, nextId, next);
            if (mode === "queued_retry")
              await markWorkRetrying(pool, nextId, new Error("new retry"), next);
            return result;
          }
          return read<T>(client, text, values);
        },
      );
      const outcome = await markQueuedWorkCancelled(pool, id, new Error("stale cancel")).catch(
        () => false,
      );
      expect(observed).toBe(true);
      expect(outcome).toBe(false);
      expect((await getWorkRow(nextId)).status).toBe(
        mode === "queued_retry" ? "queued" : "running",
      );
      await expect(leaseRepository.isPrActorLeaseHeld(pool, nextId, epoch + 1)).resolves.toBe(true);
      if (mode === "queued_retry") await claimWorkForExecution(pool, nextId, epoch + 1);
      await expect(markWorkCompleted(pool, nextId, epoch + 1)).resolves.toBe(true);
    },
  );

  it("finishes a queued reread retry before locking the first claim epoch (#661)", async () => {
    const id = await insertWorkItem({ status: "running" });
    const key = `repo-it-${id}`;
    const claimant = await pool.connect();
    const { rows } = await claimant.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const claimantPid = rows[0]?.pid;
    const read = postgres.queryOne;
    let observed = false;
    let open = false;
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    vi.spyOn(postgres, "queryOne").mockImplementation(
      async <T extends QueryResultRow>(
        client: Pool | PoolClient,
        text: string,
        values: unknown[] = [],
      ) => {
        if (
          !observed &&
          values[0] === id &&
          text.includes("execution_epoch") &&
          text.includes("SELECT")
        ) {
          observed = true;
          await markWorkRetrying(pool, id, new Error("legacy retry"), null);
          const result = await read<T>(client, text, values);
          await claimant.query("BEGIN");
          open = true;
          const acquisition = await acquirePrActorLease(claimant, {
            resourceKey: key,
            workType: "review",
            workItemId: id,
            holderId: "repo-it-first-claim",
            ttlSeconds: 900,
          });
          if (!acquisition.acquired) throw new Error("expected first claim lease");
          await claimWorkForExecution(claimant, id, acquisition.leaseEpoch);
          releaseReady?.();
          return result;
        }
        return read<T>(client, text, values);
      },
    );
    const operation = markQueuedWorkCancelled(pool, id, new Error("parent terminal")).then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await Promise.race([ready, operation]);
      expect(observed).toBe(true);
      await expect
        .poll(async () => {
          const { rows: waiting } = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database()
               AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`,
            [claimantPid],
          );
          return waiting[0]?.blocked;
        })
        .toBe(true);
      await claimant.query("COMMIT");
      open = false;
      expect(await operation).toBe(true);
      expect((await getWorkRow(id)).status).toBe("cancelled");
      await expect(markWorkCompleted(pool, id, 1)).resolves.toBe(false);
    } finally {
      if (open) await claimant.query("ROLLBACK");
      await operation;
      claimant.release();
    }
  });

  it("serializes a replacement cancellation fence against takeover (#661)", async () => {
    const id = await insertWorkItem();
    const key = `repo-it-${id}`;
    const epoch = await acquireReviewLease(id, key);
    await claimWorkForExecution(pool, id, epoch);
    const lock = leaseRepository.lockPrActorLeaseForUpdate;
    let unlock: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let lockedReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      lockedReady = resolve;
    });
    vi.spyOn(leaseRepository, "lockPrActorLeaseForUpdate").mockImplementation(async (...args) => {
      await lock(...args);
      lockedReady?.();
      await release;
    });
    const cancel = markQueuedWorkCancelled(pool, id, new Error("parent terminal")).then(
      (value) => value,
      (error: unknown) => error,
    );
    const contender = await pool.connect();
    const { rows } = await contender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    let takeover: Promise<unknown> | undefined;
    try {
      await Promise.race([ready, cancel]);
      takeover = acquirePrActorLease(contender, {
        resourceKey: key,
        workType: "review",
        workItemId: id,
        holderId: "repo-it-contender",
        ttlSeconds: 900,
      });
      await expect
        .poll(async () => {
          const result = await pool.query<{ waiting: boolean }>(
            "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
            [rows[0]?.pid],
          );
          return result.rows[0]?.waiting;
        })
        .toBe(true);
      unlock?.();
      expect(await cancel).toBe(true);
      expect(await takeover).toMatchObject({ acquired: false });
      expect((await getWorkRow(id)).status).toBe("cancelled");
    } finally {
      unlock?.();
      await cancel;
      await takeover;
      contender.release();
    }
  });

  it("requeues retrying work and increments attempt on the next claim", async () => {
    const id = await insertWorkItem({ status: "running", attemptCount: 1 });

    await expect(markWorkRetrying(pool, id, new Error("retry me"), null)).resolves.toBe(true);

    const retrying = await getWorkRow(id);
    expect(retrying.status).toBe("queued");
    expect(retrying.attempt_count).toBe(1);
    expect(retrying.last_error).toBe("retry me");

    await expect(claimWorkForExecution(pool, id)).resolves.toMatchObject({
      attemptCount: 2,
      resumed: false,
    });
    await expect(getWorkRow(id)).resolves.toMatchObject({
      status: "running",
      attempt_count: 2,
    });
  });

  it("only force-completes rescheduled parents with a replacement marker", async () => {
    const ordinary = await insertWorkItem({ status: "running", attemptCount: 1 });
    const legacy = await insertWorkItem({
      status: "queued",
      payload: { staleHeadReplacementWorkItemId: "replacement-wi" },
    });
    const nested = await insertWorkItem({
      status: "queued",
      payload: {
        staleHeadReplacement: {
          replacementWorkItemId: "replacement-wi-2",
          state: "pending-enqueue",
        },
      },
    });
    const ordinaryEpoch = await acquireReviewLease(ordinary, `repo-it-${ordinary}`);
    const legacyEpoch = await acquireReviewLease(legacy, `repo-it-${legacy}`);
    const nestedEpoch = await acquireReviewLease(nested, `repo-it-${nested}`);

    await expect(forceMarkRescheduledParentCompleted(pool, ordinary, ordinaryEpoch)).resolves.toBe(
      false,
    );
    await expect(forceMarkRescheduledParentCompleted(pool, legacy, legacyEpoch)).resolves.toBe(
      true,
    );
    await expect(forceMarkRescheduledParentCompleted(pool, nested, nestedEpoch)).resolves.toBe(
      true,
    );

    await expect(getWorkRow(ordinary)).resolves.toMatchObject({ status: "running" });
    await expect(getWorkRow(legacy)).resolves.toMatchObject({ status: "completed" });
    await expect(getWorkRow(nested)).resolves.toMatchObject({ status: "completed" });
  });

  it("fences forced rescheduled-parent completion on the active lease epoch", async () => {
    const resourceKey = `repo-it-forced-complete-${randomUUID()}`;
    const id = await insertWorkItem({
      status: "running",
      attemptCount: 1,
      resourceKey,
      payload: {
        staleHeadReplacement: {
          replacementWorkItemId: "replacement-wi",
          state: "pending-enqueue",
        },
      },
    });
    const leaseEpoch = await acquireReviewLease(id, resourceKey);

    await expect(forceMarkRescheduledParentCompleted(pool, id, leaseEpoch + 1)).resolves.toBe(
      false,
    );
    await expect(getWorkRow(id)).resolves.toMatchObject({ status: "running" });
    await expect(forceMarkRescheduledParentCompleted(pool, id, leaseEpoch)).resolves.toBe(true);
  });

  it("admits concurrent claims: single-actor exclusion lives on the PR actor lease", async () => {
    const id = await insertWorkItem();

    const claims = await Promise.all([
      claimWorkForExecution(pool, id),
      claimWorkForExecution(pool, id),
    ]);
    const attemptCounts = claims
      .map((claim) => claim?.attemptCount)
      .toSorted((left, right) => (left ?? 0) - (right ?? 0));
    expect(attemptCounts).toEqual([1, 2]);
    expect(claims.filter((claim) => claim?.resumed)).toHaveLength(1);

    await expect(getWorkRow(id)).resolves.toMatchObject({
      status: "running",
      attempt_count: 2,
    });
  });

  it("keeps ask publish records separate per work item", async () => {
    const resourceKey = "repo-it-shared-ask";
    const first = await insertAskWorkItem(resourceKey);
    const second = await insertAskWorkItem(resourceKey);

    await recordAskPublishStep(pool, {
      workItemId: first,
      leaseEpoch: null,
      resourceKey,
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation" },
    });
    await recordAskPublishStep(pool, {
      workItemId: second,
      leaseEpoch: null,
      resourceKey,
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation" },
    });

    await expect(
      hasCompletedPublishStep(pool, first, resourceKey, "ask", "ask_reply"),
    ).resolves.toBe(true);
    await expect(
      hasCompletedPublishStep(pool, second, resourceKey, "ask", "ask_reply"),
    ).resolves.toBe(true);

    const { rows } = await pool.query<{ work_item_id: string }>(
      `SELECT work_item_id
         FROM publish_records
        WHERE resource_key = $1
          AND review_lens = 'ask'
          AND step = 'ask_reply'
          AND status = 'completed'`,
      [resourceKey],
    );
    expect(rows.map((row) => row.work_item_id).toSorted()).toEqual([first, second].toSorted());
  });

  it("keeps review check run records separate per work item", async () => {
    const resourceKey = "repo-it-shared-review";
    const first = await insertWorkItem({ resourceKey });
    const second = await insertWorkItem({ resourceKey });

    await recordReviewCheckRun(pool, {
      workItemId: first,
      resourceKey,
      reviewLens: "review",
      githubId: 111,
      detail: { status: "in_progress" },
    });
    await recordReviewCheckRun(pool, {
      workItemId: second,
      resourceKey,
      reviewLens: "review",
      githubId: 222,
      detail: { status: "in_progress" },
    });

    const { rows } = await pool.query<{ work_item_id: string; github_id: string }>(
      `SELECT work_item_id, github_id
         FROM publish_records
        WHERE resource_key = $1
          AND review_lens = 'review'
          AND step = 'check_run'
          AND status = 'completed'
        ORDER BY github_id`,
      [resourceKey],
    );
    expect(rows).toEqual([
      { work_item_id: first, github_id: "111" },
      { work_item_id: second, github_id: "222" },
    ]);
  });

  it.each([false, true])(
    "own verdict concurrent null epoch keeps the first conclusion (same outcome: %s)",
    async (sameOutcome) => {
      const id = await insertWorkItem({ status: "completed" });
      const resourceKey = `repo-it-${id}`;
      const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const check = await surface.startReviewCheck("h", id);
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const finish = surface.finishReviewCheck.bind(surface);
      const finishSpy = vi
        .spyOn(surface, "finishReviewCheck")
        .mockImplementationOnce(async (output) => {
          entered();
          await barrier;
          await finish(output);
        });
      const statusSpy = vi.spyOn(surface, "setReviewCommitStatus");
      const params = {
        pool,
        prSurface: surface,
        owner: OWNER,
        repo: "r",
        prNumber: 1,
        workItemId: id,
        resourceKey,
        reviewLens: "review" as const,
        headSha: "h",
        commitStatusEnabled: true,
        leaseEpoch: null,
        outcome: {
          kind: "published" as const,
          findings: [{ severity: "P1" as const }],
          summary: "first verdict",
        },
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("own verdict contender did not settle")), 3000);
      });
      const first = closeOwnVerdict(params);
      let second: Promise<void> | undefined;
      try {
        await Promise.race([entry, timeout]);
        second = closeOwnVerdict({
          ...params,
          outcome: sameOutcome
            ? params.outcome
            : { kind: "published", findings: [], summary: "losing verdict" },
        });
        await Promise.race([second, timeout]);
        const apply = vi.fn(async () => true);
        await expect(
          closeRepository.withOwnVerdictClose(pool, params, apply),
        ).resolves.toBeUndefined();
        expect(apply).not.toHaveBeenCalled();
        expect(finishSpy).toHaveBeenCalledTimes(1);
        expect(statusSpy).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.allSettled([first, ...(second == null ? [] : [second])]);
        clearTimeout(timer);
      }
      await closeOwnVerdict({
        ...params,
        outcome: { kind: "crashed", summary: "post-release contender" },
      });
      expect(finishSpy).toHaveBeenCalledTimes(1);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(finishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          checkRunId: check.id,
          conclusion: "failure",
          summary: "first verdict",
        }),
      );
      expect(statusSpy).toHaveBeenCalledWith(
        "h",
        expect.objectContaining({
          state: "failure",
          description: "first verdict",
        }),
      );
      const { rows } = await pool.query(
        "SELECT github_id, detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        github_id: String(check.id),
        detail: { status: "completed", conclusion: "failure" },
      });
    },
  );

  it("own verdict acknowledgement keeps an already closed verdict", async () => {
    const id = await insertWorkItem({ status: "completed" });
    const resourceKey = `repo-it-${id}`;
    const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    await recordReviewCheckRun(pool, {
      workItemId: id,
      resourceKey,
      reviewLens: "review",
      githubId: 111,
      detail: { status: "in_progress" },
    });
    const finish = vi.spyOn(surface, "finishReviewCheck");
    const status = vi.spyOn(surface, "setReviewCommitStatus");
    await closeOwnVerdict({
      pool,
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemId: id,
      resourceKey,
      reviewLens: "review",
      headSha: "h",
      commitStatusEnabled: true,
      leaseEpoch: null,
      outcome: { kind: "published", findings: [] },
    });
    const before = await pool.query(
      "SELECT id, detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    await closeOwnVerdictsForWorkItems(pool, {
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemIds: [id],
      commitStatusEnabled: true,
      outcome: { kind: "cancelled" },
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    const after = await pool.query(
      "SELECT id, detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it.each(["queued", "running"] as const)(
    "own verdict unleased close cannot finish %s work",
    async (workStatus) => {
      const id = await insertWorkItem({ status: workStatus });
      const { surface, controls } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey: `repo-it-${id}`,
        reviewLens: "review",
        githubId: 111,
        detail: { status: "in_progress" },
      });
      for (const leaseEpoch of [null, undefined]) {
        await closeOwnVerdict({
          pool,
          prSurface: surface,
          owner: OWNER,
          repo: "r",
          prNumber: 1,
          workItemId: id,
          resourceKey: `repo-it-${id}`,
          reviewLens: "review",
          headSha: "h",
          commitStatusEnabled: true,
          leaseEpoch,
          outcome: { kind: "cancelled" },
        });
      }
      expect(controls.events).toEqual([]);
    },
  );

  it.each([
    "check_rejected",
    "status_rejected",
    "check_unknown",
    "receipt_failure",
    "no_check",
    "deferred",
    "empty",
    "flag_off",
  ] as const)("own verdict repairs only the selected missing surfaces after %s", async (mode) => {
    const id = await insertWorkItem({ status: "completed" });
    const resourceKey = `repo-it-${id}`;
    const { surface, controls } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    if (mode !== "no_check")
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: 111,
        detail: { status: "in_progress" },
      });
    const finish = vi.spyOn(surface, "finishReviewCheck");
    const status = vi.spyOn(surface, "setReviewCommitStatus");
    if (mode === "check_rejected")
      finish.mockRejectedValueOnce(Object.assign(new Error("rejected"), { accepted: false }));
    if (mode === "status_rejected")
      status.mockRejectedValueOnce(Object.assign(new Error("rejected"), { accepted: false }));
    if (mode === "check_unknown") finish.mockRejectedValueOnce(new Error("response lost"));
    const params = {
      pool,
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemId: id,
      resourceKey,
      reviewLens: "review" as const,
      headSha: mode === "deferred" ? "deferred-to-worker" : mode === "empty" ? "" : "h",
      commitStatusEnabled: mode !== "flag_off",
      leaseEpoch: null,
      outcome: {
        kind: "published" as const,
        findings: [{ severity: "P1" as const }],
        summary: "winner",
      },
    };
    const receiptSpy = vi.spyOn(closeRepository, "recordOwnVerdictSurfaceApplied");
    if (mode === "receipt_failure")
      receiptSpy.mockRejectedValueOnce(new Error("synthetic receipt failure"));
    try {
      await closeOwnVerdict(params);
    } finally {
      receiptSpy.mockRestore();
    }
    const saved = await closeRepository.getOwnVerdictCloseRecord(pool, params);
    await closeOwnVerdict({
      ...params,
      headSha: "h",
      commitStatusEnabled: true,
      outcome: { kind: "published", findings: [], summary: "loser" },
    });
    const accepted = controls.events.filter((event) => event.kind === "finishReviewCheck");
    if (mode === "check_unknown" || mode === "no_check") expect(accepted).toEqual([]);
    else expect(accepted).toEqual([expect.objectContaining({ conclusion: "failure" })]);
    expect(finish).toHaveBeenCalledTimes(
      mode === "check_rejected" ? 2 : mode === "no_check" ? 0 : 1,
    );
    for (const [output] of finish.mock.calls)
      expect(output).toMatchObject({ conclusion: "failure", summary: "winner" });
    const statuses = controls.events.filter((event) => event.kind === "setReviewCommitStatus");
    expect(statuses).toHaveLength(["deferred", "empty", "flag_off"].includes(mode) ? 0 : 1);
    for (const [, output] of status.mock.calls)
      expect(output).toMatchObject({ state: "failure", description: "winner" });
    const { rows } = await pool.query(
      "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    expect(rows).toHaveLength(1);
    if (mode !== "no_check" && mode !== "check_unknown")
      expect(rows[0].detail).toMatchObject({ status: "completed", conclusion: "failure" });
    if (["deferred", "empty", "flag_off"].includes(mode)) {
      expect(status).not.toHaveBeenCalled();
      expect(rows[0].detail.selectedOwnVerdict).toEqual(saved?.selected);
      expect(rows[0].detail.ownCheckApplied).toBe(true);
      expect(rows[0].detail.ownStatusApplied).not.toBe(true);
    }
  });

  it.each(["check_mismatch", "status_mismatch", "check_without_id"] as const)(
    "own verdict receipt rejects %s without changing the winner row",
    async (mode) => {
      const id = await insertWorkItem({ status: "completed" });
      const identity = {
        workItemId: id,
        resourceKey: `repo-it-${id}`,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      if (mode !== "check_without_id")
        await recordReviewCheckRun(pool, {
          ...identity,
          githubId: 111,
          detail: { status: "in_progress" },
        });
      const selected = {
        conclusion: "failure" as const,
        summary: "winner",
        status: { headSha: "h", enabled: true, state: "failure" as const },
      };
      await closeRepository.claimOwnVerdict(pool, { ...identity, selected });
      const before = await pool.query("SELECT * FROM publish_records WHERE work_item_id = $1", [
        id,
      ]);
      await expect(
        closeRepository.recordOwnVerdictSurfaceApplied(
          pool,
          {
            ...identity,
            selected:
              mode === "check_without_id"
                ? selected
                : {
                    conclusion: "success",
                    summary: "loser",
                    status: { headSha: "h", enabled: true, state: "success" },
                  },
          },
          mode === "status_mismatch" ? "status" : "check",
        ),
      ).rejects.toMatchObject({ code: "agent_work.own_verdict_receipt_rejected" });
      const after = await pool.query("SELECT * FROM publish_records WHERE work_item_id = $1", [id]);
      expect(after.rows).toEqual(before.rows);
      expect(after.rows[0].detail.selectedOwnVerdict).toEqual(selected);
      expect(after.rows[0].detail.ownCheckApplied).toBeUndefined();
      expect(after.rows[0].detail.ownStatusApplied).toBeUndefined();
      console.log("own-verdict-rejected-receipt", JSON.stringify({ mode, unchanged: true }));
    },
  );

  it.each(["completed", "unknown", "mutating", "saved_result", "rejected"] as const)(
    "own verdict preserves legacy completion evidence %s",
    async (mode) => {
      const id = await insertWorkItem({ status: "completed" });
      const resourceKey = `repo-it-${id}`;
      const { surface, controls } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: 111,
        detail:
          mode === "completed"
            ? { status: "completed", conclusion: "success" }
            : { status: "in_progress" },
      });
      if (mode !== "completed")
        await pool.query(
          `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
         VALUES ($1, $2, 'pr-surface:finishReviewCheck:legacy', 'github.pr_surface.finishReviewCheck', $3, $4::jsonb)`,
          [
            randomUUID(),
            id,
            mode === "unknown" ? "outcome_unknown" : mode === "rejected" ? "failed" : "pending",
            JSON.stringify({
              surfaceMethod: "finishReviewCheck",
              ...(mode === "saved_result"
                ? { __result: null }
                : mode === "mutating"
                  ? { __mutating: true }
                  : {}),
            }),
          ],
        );
      await closeOwnVerdict({
        pool,
        prSurface: surface,
        owner: OWNER,
        repo: "r",
        prNumber: 1,
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        headSha: "h",
        commitStatusEnabled: true,
        leaseEpoch: null,
        outcome: { kind: "cancelled" },
      });
      expect(controls.events.filter((event) => event.kind === "finishReviewCheck")).toHaveLength(
        mode === "rejected" ? 1 : 0,
      );
      expect(
        controls.events.filter((event) => event.kind === "setReviewCommitStatus"),
      ).toHaveLength(mode === "rejected" ? 1 : 0);
    },
  );

  it("own verdict two-client CAS returns the immutable visible winner", async () => {
    const { claimOwnVerdict } = await import("../../src/agentWork/publishRecordRepository.js");
    const id = await insertWorkItem({ status: "completed" });
    const resourceKey = `repo-it-${id}`;
    await recordReviewCheckRun(pool, {
      workItemId: id,
      resourceKey,
      reviewLens: "review",
      githubId: 111,
      detail: { status: "in_progress" },
    });
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    let contender: ReturnType<typeof claimOwnVerdict> | undefined;
    try {
      const initial = await Promise.all(
        clients.map((client) =>
          client.query(
            "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
            [id],
          ),
        ),
      );
      for (const result of initial)
        expect(result.rows[0].detail.selectedOwnVerdict).toBeUndefined();
      const { rows: pids } = await clients[0].query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await clients[1].query("BEGIN");
      const winner = await claimOwnVerdict(clients[1], {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        leaseEpoch: null,
        selected: {
          conclusion: "success",
          summary: "first writer",
          status: { headSha: "h", enabled: true, state: "success" },
        },
      });
      contender = claimOwnVerdict(clients[0], {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        leaseEpoch: null,
        selected: {
          conclusion: "failure",
          summary: "loser",
          status: { headSha: "h", enabled: true, state: "failure" },
        },
      });
      // Observe the real write conflict, not a sleep that might miss the race.
      await expect
        .poll(
          async () => {
            const result = await pool.query(
              "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
              [pids[0].pid],
            );
            return result.rows[0]?.wait_event_type;
          },
          { timeout: 3000 },
        )
        .toBe("Lock");
      await clients[1].query("COMMIT");
      const outputs = [await contender, winner];
      expect(outputs[0]?.selected).toEqual(outputs[1]?.selected);
      const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const finish = vi.spyOn(surface, "finishReviewCheck");
      const status = vi.spyOn(surface, "setReviewCommitStatus");
      await closeOwnVerdict({
        pool,
        prSurface: surface,
        owner: OWNER,
        repo: "r",
        prNumber: 1,
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        headSha: "h",
        leaseEpoch: null,
        commitStatusEnabled: true,
        outcome: { kind: "cancelled" },
      });
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: outputs[0]?.selected?.conclusion,
          summary: outputs[0]?.selected?.summary,
        }),
      );
      expect(status).toHaveBeenCalledWith(
        "h",
        expect.objectContaining({
          state: outputs[0]?.selected?.status?.state,
          description: outputs[0]?.selected?.summary,
        }),
      );
    } finally {
      await clients[1].query("ROLLBACK");
      if (contender != null) await Promise.allSettled([contender]);
      for (const client of clients) client.release();
    }
  });

  it("own verdict protects and reclaims a creation reservation on the same row", async () => {
    const { claimOwnVerdict, reserveReviewCheckRun, releaseUnstartedReviewCheckRunReservation } =
      await import("../../src/agentWork/publishRecordRepository.js");
    const id = await insertWorkItem({ status: "completed" });
    const params = {
      workItemId: id,
      resourceKey: `repo-it-${id}`,
      reviewLens: "review" as const,
      leaseEpoch: null,
    };
    await claimOwnVerdict(pool, {
      ...params,
      selected: { conclusion: "failure", summary: "winner" },
    });
    const before = await pool.query(
      "SELECT id FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    const reserves = await Promise.all(
      [1, 2].map(() => reserveReviewCheckRun(pool, { ...params, detail: { status: "starting" } })),
    );
    expect(reserves.toSorted((a, b) => Number(a) - Number(b))).toEqual([false, true]);
    await claimOwnVerdict(pool, {
      ...params,
      selected: { conclusion: "success", summary: "late claim during creation" },
    });
    const starting = await pool.query(
      "SELECT id, github_id, detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    expect(starting.rows[0]).toMatchObject({
      id: before.rows[0].id,
      github_id: null,
      detail: {
        status: "starting",
        selectedOwnVerdict: { conclusion: "failure", summary: "winner" },
      },
    });
    expect(
      await releaseUnstartedReviewCheckRunReservation(pool, {
        ...params,
        staleBefore: new Date(0),
      }),
    ).toBe(false);
    expect(await releaseUnstartedReviewCheckRunReservation(pool, params)).toBe(true);
    expect(await reserveReviewCheckRun(pool, { ...params, detail: { status: "starting" } })).toBe(
      true,
    );
    await recordReviewCheckRun(pool, {
      ...params,
      githubId: 111,
      detail: { status: "in_progress" },
    });
    expect(await reserveReviewCheckRun(pool, { ...params, detail: { status: "starting" } })).toBe(
      false,
    );
    const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    const finish = vi.spyOn(surface, "finishReviewCheck");
    await closeOwnVerdict({
      ...params,
      pool,
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      headSha: "h",
      commitStatusEnabled: false,
      outcome: { kind: "cancelled" },
    });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "failure", summary: "winner" }),
    );
    const after = await pool.query(
      "SELECT id, github_id, detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
      [id],
    );
    expect(after.rows[0]).toMatchObject({
      id: before.rows[0].id,
      github_id: "111",
      detail: { conclusion: "failure", status: "completed" },
    });
  });

  it("own verdict single-slot pool closes unleased work and rejects leased entry before selection", async () => {
    const scopedPool = new Pool({ ...pool.options, max: 1, connectionTimeoutMillis: 1500 });
    const id = await insertWorkItem({ status: "completed" });
    const resourceKey = `repo-it-${id}`;
    const leaseEpoch = await acquireReviewLease(id, resourceKey);
    const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    const finish = vi.spyOn(surface, "finishReviewCheck");
    const params = {
      pool: scopedPool,
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemId: id,
      resourceKey,
      reviewLens: "review" as const,
      headSha: "h",
      commitStatusEnabled: false,
      outcome: { kind: "published" as const, findings: [] },
    };
    try {
      await recordReviewCheckRun(scopedPool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: 111,
        detail: { status: "in_progress" },
      });
      await expect(closeOwnVerdict({ ...params, leaseEpoch })).rejects.toMatchObject({
        code: "agent_work.own_verdict_capacity",
      });
      expect(finish).not.toHaveBeenCalled();
      const before = await scopedPool.query(
        "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      expect(before.rows[0].detail.selectedOwnVerdict).toBeUndefined();
      const intents = await scopedPool.query(
        "SELECT id FROM operation_intents WHERE work_item_id = $1",
        [id],
      );
      expect(intents.rows).toEqual([]);
      await closeOwnVerdict({ ...params, leaseEpoch: null });
      expect(finish).toHaveBeenCalledOnce();
    } finally {
      await scopedPool.end();
    }
  });

  it.each([
    { conclusion: "failure", state: "failure" },
    { conclusion: "success", state: "success" },
    { conclusion: "neutral", state: "error" },
    { conclusion: "cancelled", state: "error" },
    { conclusion: "action_required", state: "error" },
  ] as const)(
    "own verdict check-only $conclusion keeps output when status is attached",
    async ({ conclusion, state }) => {
      const { completeReviewCheckRun } = await import("../../src/agentWork/reviewCheckRun.js");
      const id = await insertWorkItem({ status: "completed" });
      const resourceKey = `repo-it-${id}`;
      const { surface, controls } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: 111,
        detail: { status: "in_progress" },
      });
      const params = {
        prSurface: surface,
        owner: OWNER,
        repo: "r",
        prNumber: 1,
        workItemId: id,
        resourceKey,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      await expect(
        completeReviewCheckRun(pool, {
          ...params,
          conclusion,
          summary: "check-only winner",
        }),
      ).resolves.toBe(true);
      const status = vi
        .spyOn(surface, "setReviewCommitStatus")
        .mockRejectedValueOnce(Object.assign(new Error("rejected"), { accepted: false }));
      await closeOwnVerdict({
        ...params,
        pool,
        headSha: "h",
        commitStatusEnabled: true,
        outcome: { kind: "cancelled" },
      });
      const open = await pool.query(
        "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      expect(open.rows[0].detail.status).toBe("in_progress");
      await closeOwnVerdict({
        ...params,
        pool,
        headSha: "h",
        commitStatusEnabled: true,
        outcome: { kind: "published", findings: [] },
      });
      expect(status).toHaveBeenLastCalledWith(
        "h",
        expect.objectContaining({ state, description: "check-only winner" }),
      );
      expect(controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([
        expect.objectContaining({ conclusion }),
      ]);
      const closed = await pool.query(
        "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      expect(closed.rows[0].detail.status).toBe("completed");
    },
  );

  it.each([
    {
      shape: "saved_result",
      childStatus: "pending",
      childDetail: { __result: null },
      parentStatus: "pending",
      applied: true,
      calls: 0,
    },
    {
      shape: "exact_reconciled",
      childStatus: "reconciled",
      childDetail: {},
      parentStatus: "pending",
      applied: true,
      calls: 0,
    },
    {
      shape: "exact_reconciled_false",
      childStatus: "reconciled",
      childDetail: { reconciledFromPublishRecord: false },
      parentStatus: "pending",
      applied: true,
      calls: 0,
    },
    {
      shape: "ledger_reconciled",
      childStatus: "reconciled",
      childDetail: { reconciledFromPublishRecord: true },
      parentStatus: "pending",
      applied: false,
      calls: 0,
    },
    {
      shape: "failed_unknown_parent",
      childStatus: "failed",
      childDetail: {},
      parentStatus: "pending",
      applied: false,
      calls: 0,
    },
    {
      shape: "failed_retryable_parent",
      childStatus: "failed",
      childDetail: {},
      parentStatus: "failed",
      applied: true,
      calls: 1,
    },
  ] as const)(
    "own verdict recovers delegated child $shape without remutating uncertainty",
    async ({ childStatus, childDetail, parentStatus, applied, calls }) => {
      const id = await insertWorkItem({ status: "completed" });
      const resourceKey = `repo-it-${id}`;
      const identity = {
        workItemId: id,
        resourceKey,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      await recordReviewCheckRun(pool, {
        ...identity,
        githubId: 111,
        detail: { status: "in_progress" },
      });
      await closeRepository.claimOwnVerdict(pool, {
        ...identity,
        selected: { conclusion: "failure", summary: "winner" },
      });
      const parentKey = closeRepository.ownVerdictCloseOperationKey(identity);
      await pool.query(
        `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
       VALUES ($1, $2, $3, 'github.review_check_run_close', $4, $5::jsonb),
              ($6, $2, $7, 'github.pr_surface.finishReviewCheck', $8, $9::jsonb)`,
        [
          randomUUID(),
          id,
          parentKey,
          parentStatus,
          JSON.stringify({
            resourceKey,
            reviewLens: "review",
            __mutating: true,
            delegationEntered: true,
          }),
          randomUUID(),
          `${parentKey}:surface:finishReviewCheck:seeded-child`,
          childStatus,
          JSON.stringify({
            parentOperationKey: parentKey,
            surfaceMethod: "finishReviewCheck",
            ...childDetail,
          }),
        ],
      );
      const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const finish = vi.spyOn(surface, "finishReviewCheck");
      for (let attempt = 0; attempt < 2; attempt += 1)
        await closeOwnVerdict({
          ...identity,
          pool,
          prSurface: surface,
          owner: OWNER,
          repo: "r",
          prNumber: 1,
          headSha: "h",
          commitStatusEnabled: false,
          outcome: { kind: "cancelled" },
        });
      expect(finish).toHaveBeenCalledTimes(calls);
      if (calls > 0)
        expect(finish).toHaveBeenCalledWith(
          expect.objectContaining({ conclusion: "failure", summary: "winner" }),
        );
      const record = await closeRepository.getOwnVerdictCloseRecord(pool, identity);
      expect(record?.checkApplied).toBe(applied);
      expect(record?.selected).toMatchObject({ conclusion: "failure", summary: "winner" });
      const parent = await pool.query(
        "SELECT status, detail FROM operation_intents WHERE work_item_id = $1 AND operation_key = $2",
        [id, parentKey],
      );
      expect(parent.rows[0].status).toBe(applied ? "reconciled" : "outcome_unknown");
      if (!applied) expect(parent.rows[0].detail.unknownResolution).toBe("terminal");
      console.log(
        "own-verdict-child-evidence",
        JSON.stringify({
          childStatus,
          childDetail,
          parentStatus,
          applied: record?.checkApplied,
          finishCalls: finish.mock.calls.length,
        }),
      );
    },
  );

  it.each(["before_lock", "application", "unlock"] as const)(
    "own verdict releases connection admission and mutex after %s failure",
    async (mode) => {
      const id = await insertWorkItem({ status: "completed" });
      const params = {
        workItemId: id,
        resourceKey: `repo-it-${id}`,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      if (mode === "before_lock") {
        vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("synthetic close failure"));
      }
      await expect(
        closeRepository.withOwnVerdictClose(pool, params, async (client) => {
          if (mode === "application") throw new Error("synthetic close failure");
          if (mode === "unlock")
            vi.spyOn(client, "query").mockRejectedValueOnce(new Error("synthetic close failure"));
          return true;
        }),
      ).rejects.toThrow("synthetic close failure");
      expect(await closeRepository.withOwnVerdictClose(pool, params, async () => true)).toBe(true);
    },
  );

  it("own verdict numeric lease can close running work but a stale epoch cannot replace it", async () => {
    const id = await insertWorkItem({ status: "running" });
    const resourceKey = `repo-it-${id}`;
    const leaseEpoch = await acquireReviewLease(id, resourceKey);
    const { surface } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    const finish = vi.spyOn(surface, "finishReviewCheck");
    await recordReviewCheckRun(pool, {
      workItemId: id,
      resourceKey,
      reviewLens: "review",
      githubId: 111,
      leaseEpoch,
      detail: { status: "in_progress" },
    });
    const params = {
      pool,
      prSurface: surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemId: id,
      resourceKey,
      reviewLens: "review" as const,
      headSha: "h",
      commitStatusEnabled: false,
      outcome: { kind: "published" as const, findings: [] },
    };
    await expect(closeOwnVerdict({ ...params, leaseEpoch: leaseEpoch + 1 })).rejects.toMatchObject({
      code: "agent_work.pr_actor_lease_lost",
    });
    expect(finish).not.toHaveBeenCalled();
    await closeOwnVerdict({ ...params, leaseEpoch });
    await expect(
      closeOwnVerdict({ ...params, leaseEpoch: leaseEpoch + 1, outcome: { kind: "cancelled" } }),
    ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it.each(["pending", "outcome_unknown"] as const)(
    "own verdict handles no-delegation evidence without reopening %s",
    async (intentStatus) => {
      const id = await insertWorkItem({ status: "completed" });
      const params = {
        workItemId: id,
        resourceKey: `repo-it-${id}`,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      await recordReviewCheckRun(pool, {
        ...params,
        githubId: 111,
        detail: { status: "in_progress" },
      });
      await closeRepository.claimOwnVerdict(pool, {
        ...params,
        selected: { conclusion: "failure", summary: "winner" },
      });
      await pool.query(
        `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
         VALUES ($1, $2, $3, 'github.review_check_run_close', $4, $5::jsonb)`,
        [
          randomUUID(),
          id,
          closeRepository.ownVerdictCloseOperationKey(params),
          intentStatus,
          JSON.stringify({
            __mutating: true,
            delegationEntered: false,
            ...(intentStatus === "outcome_unknown" ? { unknownResolution: "terminal" } : {}),
          }),
        ],
      );
      const { surface, controls } = createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      await closeOwnVerdict({
        ...params,
        pool,
        prSurface: surface,
        owner: OWNER,
        repo: "r",
        prNumber: 1,
        headSha: "h",
        commitStatusEnabled: false,
        outcome: { kind: "cancelled" },
      });
      expect(controls.events.filter((event) => event.kind === "finishReviewCheck")).toHaveLength(
        intentStatus === "pending" ? 1 : 0,
      );
    },
  );
});
