import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { runRetention } from "../../src/agentWork/retention.js";
import { hasDatabase, integrationPool } from "./db.js";

const RETENTION = {
  agentWorkRetentionSeconds: 30 * 86_400,
  webhookEventsRetentionSeconds: 30 * 86_400,
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
});
