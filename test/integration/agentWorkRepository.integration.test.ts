import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import {
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
  hasCompletedPublishStep,
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

  it("claims queued work and increments the attempt count", async () => {
    const id = await insertWorkItem();

    await expect(claimWorkForExecution(pool, id)).resolves.toBe(true);

    const row = await getWorkRow(id);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(1);
    expect(row.started_at).toBeInstanceOf(Date);
  });

  it("claims running work again through the resume path without bumping attempts", async () => {
    const id = await insertWorkItem();

    await claimWorkForExecution(pool, id);
    await expect(claimWorkForExecution(pool, id)).resolves.toBe(true);

    const row = await getWorkRow(id);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(1);
  });

  it("does not claim work after cancellation is requested", async () => {
    const id = await insertWorkItem({ cancelRequestedAt: new Date().toISOString() });

    await expect(claimWorkForExecution(pool, id)).resolves.toBe(false);

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

  it("requeues retrying work and increments attempt on the next claim", async () => {
    const id = await insertWorkItem({ status: "running", attemptCount: 1 });

    await expect(markWorkRetrying(pool, id, new Error("retry me"), null)).resolves.toBe(true);

    const retrying = await getWorkRow(id);
    expect(retrying.status).toBe("queued");
    expect(retrying.attempt_count).toBe(1);
    expect(retrying.last_error).toBe("retry me");

    await expect(claimWorkForExecution(pool, id)).resolves.toBe(true);
    await expect(getWorkRow(id)).resolves.toMatchObject({
      status: "running",
      attempt_count: 2,
    });
  });

  it("only force-completes rescheduled parents with a replacement marker", async () => {
    const ordinary = await insertWorkItem({ status: "running", attemptCount: 1 });
    const rescheduled = await insertWorkItem({
      status: "queued",
      payload: { staleHeadReplacementWorkItemId: "replacement-wi" },
    });

    await expect(forceMarkRescheduledParentCompleted(pool, ordinary)).resolves.toBe(false);
    await expect(forceMarkRescheduledParentCompleted(pool, rescheduled)).resolves.toBe(true);

    await expect(getWorkRow(ordinary)).resolves.toMatchObject({ status: "running" });
    await expect(getWorkRow(rescheduled)).resolves.toMatchObject({ status: "completed" });
  });

  it("admits concurrent claims: single-actor exclusion lives on the PR actor lease", async () => {
    const id = await insertWorkItem();

    const claims = await Promise.all([
      claimWorkForExecution(pool, id),
      claimWorkForExecution(pool, id),
    ]);
    expect(claims).toEqual([true, true]);

    await expect(getWorkRow(id)).resolves.toMatchObject({
      status: "running",
      attempt_count: 1,
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
});
