import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";

const EXPECTED_MIGRATIONS = [
  "001_agent_work.sql",
  "002_review_quality_lens.sql",
  "003_description_work.sql",
  "004_indexes.sql",
  "005_retention_indexes.sql",
  "006_auto_fix.sql",
  "007_decouple_auto_fix_work_items.sql",
];

describe.skipIf(!hasDatabase)("migrations (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records every migration file", async () => {
    const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    const versions = rows.map((r) => r.version);
    for (const file of EXPECTED_MIGRATIONS) {
      expect(versions).toContain(file);
    }
  });

  it("creates the agent work item indexes", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'agent_work_items'",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("agent_work_items_superseded_by_idx");
    expect(names).toContain("agent_work_items_resource_type_status_idx");
    expect(names).toContain("agent_work_items_status_completed_at_idx");
  });

  it("is idempotent under concurrent runs (advisory lock)", async () => {
    await expect(Promise.all([runMigrations(pool), runMigrations(pool)])).resolves.toHaveLength(2);
  });
});
