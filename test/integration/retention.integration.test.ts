import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { runRetention } from "../../src/agentWork/retention.js";
import { DEFAULT_AGENT_EVENTS_RETENTION_SECONDS } from "../../src/settings/index.js";
import { hasDatabase, integrationPool } from "./db.js";

const RETENTION = {
  agentWorkRetentionSeconds: 30 * 86_400,
  webhookEventsRetentionSeconds: 30 * 86_400,
  agentEventsRetentionSeconds: 0,
  codeIndexRetentionSeconds: 30 * 86_400,
};
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
    await pool.query("DELETE FROM pr_head_ci_state WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM agent_events WHERE event_kind = $1", [EVENT]);
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

  it("deletes expired resume snapshots but keeps unexpired ones", async () => {
    const workItemId = await insertWorkItem("completed", daysAgo(1));
    const expiredId = randomUUID();
    const freshId = randomUUID();
    const blob = Buffer.from("x");

    await pool.query(
      `INSERT INTO agent_resume_snapshots (
         id, work_item_id, session_role, installation_id, envelope_version,
         model_provider, model_id, sdk_version, prompt_version, tool_policy_version,
         checkpoint_id, expires_at, nonce, ciphertext, auth_tag
       ) VALUES
         ($1, $3, 'ask', 1, 1, 'p', 'm', 's', 'pr', 'tp', 'c1', $4, $5, $5, $5),
         ($2, $3, 'description', 1, 1, 'p', 'm', 's', 'pr', 'tp', 'c2', $6, $5, $5, $5)`,
      [
        expiredId,
        freshId,
        workItemId,
        daysAgo(1),
        blob,
        new Date(Date.now() + 86_400_000).toISOString(),
      ],
    );

    const result = await runRetention(pool, RETENTION);
    expect(result.resumeSnapshotsDeleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_resume_snapshots WHERE work_item_id = $1",
      [workItemId],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(expiredId);
    expect(ids).toContain(freshId);
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
      agentEventsRetentionSeconds: DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
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
