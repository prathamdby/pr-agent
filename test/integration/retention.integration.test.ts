import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { runRetention } from "../../src/agentWork/retention.js";
import {
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  RETENTION_DELETE_BATCH_SIZE,
} from "../../src/settings/index.js";
import { makeTestConfig } from "../helpers/config.js";
import { hasDatabase, integrationPool } from "./db.js";

const RETENTION = makeTestConfig({
  retention: { agentWorkSeconds: 30 * 86_400, webhookEventsSeconds: 30 * 86_400 },
  agentEvents: { retentionSeconds: 0 },
  codeIndex: { retentionSeconds: 30 * 86_400 },
});
const OWNER = "retention-it";
const EVENT = "retention-it";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe.skipIf(!hasDatabase)("retention (integration)", () => {
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
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await pool.query("DELETE FROM webhook_delivery_duplicates WHERE event_name = $1", [EVENT]);
    await pool.query("DELETE FROM pr_head_ci_state WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM agent_events WHERE event_kind = $1", [EVENT]);
    await pool.query("DELETE FROM pr_review_approvals WHERE owner = $1", [OWNER]);
  });

  async function insertWorkItem(
    status: string,
    completedAt: string | null,
    updatedAt: string = completedAt ?? new Date().toISOString(),
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, resource_key, completed_at, updated_at)
       VALUES ($1, 'review', 'auto', $2, $3, 'r', 1, 1, 'h', $4, $5, $6)`,
      [id, status, OWNER, `k-${id}`, completedAt, updatedAt],
    );
    return id;
  }

  it("deletes aged terminal work items but keeps fresh and non-terminal", async () => {
    const aged = await insertWorkItem("completed", daysAgo(60));
    const fresh = await insertWorkItem("completed", daysAgo(1));
    const agedQueued = await insertWorkItem("queued", daysAgo(60));

    const result = await runRetention(pool, RETENTION);
    expect(result.workItemsDeleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_work_items WHERE owner = $1",
      [OWNER],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(aged);
    expect(ids).toContain(fresh);
    expect(ids).toContain(agedQueued);
  });

  it("uses updated_at for terminal work items without completed_at", async () => {
    const agedSuperseded = await insertWorkItem("superseded", null, daysAgo(60));
    const freshSuperseded = await insertWorkItem("superseded", null, daysAgo(1));

    const result = await runRetention(pool, RETENTION);
    expect(result.workItemsDeleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_work_items WHERE owner = $1",
      [OWNER],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(agedSuperseded);
    expect(ids).toContain(freshSuperseded);
  });

  it("deletes aged webhook events but keeps fresh ones", async () => {
    const agedId = randomUUID();
    const freshId = randomUUID();
    await pool.query(
      `INSERT INTO webhook_events
         (id, dedupe_key, event_name, body_sha256, processing_decision, received_at)
       VALUES ($1, $2, $5, 'x', 'processed', $3), ($4, $6, $5, 'x', 'processed', now())`,
      [agedId, `d-${agedId}`, daysAgo(60), freshId, EVENT, `d-${freshId}`],
    );

    await runRetention(pool, RETENTION);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM webhook_events WHERE event_name = $1",
      [EVENT],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(agedId);
    expect(ids).toContain(freshId);
  });

  it("deletes approval records by last update and preserves fresh rows across all states", async () => {
    for (const state of ["awaiting", "approved", "withdrawn"]) {
      await pool.query(
        `INSERT INTO pr_review_approvals (resource_key, owner, repo, pr_number, head_sha, state, created_at, updated_at)
         VALUES ($1, $3, 'r', 1, 'h', $4, $5, $5), ($2, $3, 'r', 2, 'h', $4, $5, now())`,
        [`${OWNER}/r#${state}-old`, `${OWNER}/r#${state}-fresh`, OWNER, state, daysAgo(60)],
      );
    }
    const result = await runRetention(pool, RETENTION);
    expect(result.reviewApprovalsDeleted).toBeGreaterThanOrEqual(3);
    const remaining = (
      await pool.query(
        "SELECT resource_key FROM pr_review_approvals WHERE owner = $1 ORDER BY resource_key",
        [OWNER],
      )
    ).rows;
    expect(remaining).toEqual(
      ["approved", "awaiting", "withdrawn"].map((state) => ({
        resource_key: `${OWNER}/r#${state}-fresh`,
      })),
    );
  });

  it("purges duplicate evidence across batches using each arrival's age", async () => {
    await pool.query(
      `INSERT INTO webhook_delivery_duplicates
         (id, event_name, body_sha256, dedupe_key, dedupe_reason, received_at)
       SELECT gen_random_uuid(), $1, repeat('a', 64), 'body:' || repeat('a', 64),
              'body_replay', CASE WHEN n <= $2 THEN $3::timestamptz ELSE now() END
         FROM generate_series(1, $2::int + 1) AS n`,
      [EVENT, RETENTION_DELETE_BATCH_SIZE + 1, daysAgo(60)],
    );
    const result = await runRetention(pool, RETENTION);
    expect(result.webhookDuplicatesDeleted).toBeGreaterThanOrEqual(RETENTION_DELETE_BATCH_SIZE + 1);
    const evidence = await pool.query<{ received_at: Date }>(
      "SELECT received_at FROM webhook_delivery_duplicates WHERE event_name = $1",
      [EVENT],
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]?.received_at.getTime()).toBeGreaterThan(Date.parse(daysAgo(1)));
    await runRetention(pool, RETENTION);
    const remaining = await pool.query(
      "SELECT id FROM webhook_delivery_duplicates WHERE event_name = $1",
      [EVENT],
    );
    expect(remaining.rows).toHaveLength(1);
  });

  it("deletes aged head CI state with no work item for that head", async () => {
    await insertWorkItem("completed", daysAgo(1));
    await pool.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, updated_at)
       VALUES
         ($1, 'r', 'orphan-aged', '{}'::jsonb, 'none', 0, $2),
         ($1, 'r', 'h', '{}'::jsonb, 'none', 0, $2),
         ($1, 'r', 'fresh', '{}'::jsonb, 'none', 0, now())`,
      [OWNER, daysAgo(60)],
    );

    const result = await runRetention(pool, RETENTION);
    expect(result.prHeadCiStateDeleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ head_sha: string }>(
      "SELECT head_sha FROM pr_head_ci_state WHERE owner = $1",
      [OWNER],
    );
    const heads = rows.map((row) => row.head_sha);
    expect(heads).not.toContain("orphan-aged");
    expect(heads).toContain("h");
    expect(heads).toContain("fresh");
  });

  it("deletes agent_events older than the default retention and keeps them when retention is 0", async () => {
    const agedId = randomUUID();
    const freshId = randomUUID();
    await pool.query(
      `INSERT INTO agent_events (id, event_kind, recorded_at)
       VALUES ($1, $3, $4), ($2, $3, $5)`,
      [agedId, freshId, EVENT, daysAgo(31), daysAgo(1)],
    );

    const deleted = await runRetention(pool, {
      ...RETENTION,
      agentEvents: {
        ...RETENTION.agentEvents,
        retentionSeconds: DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
      },
    });
    expect(deleted.agentEventsDeleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_events WHERE event_kind = $1",
      [EVENT],
    );
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain(agedId);
    expect(ids).toContain(freshId);

    const keptId = randomUUID();
    await pool.query(`INSERT INTO agent_events (id, event_kind, recorded_at) VALUES ($1, $2, $3)`, [
      keptId,
      EVENT,
      daysAgo(31),
    ]);
    await runRetention(pool, RETENTION);
    const kept = await pool.query<{ id: string }>(
      "SELECT id FROM agent_events WHERE event_kind = $1",
      [EVENT],
    );
    expect(kept.rows.map((row) => row.id)).toContain(keptId);
  });

  it("applies the agent_events recorded_at index", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'agent_events_recorded_at_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(recorded_at)");
  });
});
