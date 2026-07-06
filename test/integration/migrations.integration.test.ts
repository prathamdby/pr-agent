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
  "006_retention_fk_indexes.sql",
  "007_ask_publish_records.sql",
  "008_review_tests_lens.sql",
  "009_summary_comment_claim.sql",
  "010_drop_max_attempts.sql",
  "011_triage_work.sql",
  "012_review_check_run_step.sql",
  "013_verification_work.sql",
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

  it("creates retention-supporting indexes", async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_work_items'",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("agent_work_items_superseded_by_idx");
    expect(names).toContain("agent_work_items_resource_type_status_idx");
    expect(names).toContain("agent_work_items_webhook_event_id_idx");
    expect(names).toContain("agent_work_items_status_retention_age_idx");
    expect(names).not.toContain("agent_work_items_status_idx");
    expect(names).not.toContain("agent_work_items_status_completed_at_idx");
    expect(names).not.toContain("agent_work_items_installation_status_idx");
    expect(rows.map((r) => r.indexdef).join("\n")).toContain("COALESCE(completed_at, updated_at)");

    const publishIndexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'publish_records'",
    );
    const publishIndexNames = publishIndexes.rows.map((r) => r.indexname);
    expect(publishIndexNames).toContain("publish_records_work_item_id_idx");
    expect(publishIndexNames).toContain("publish_records_unique_shared_step_idx");
    expect(publishIndexNames).toContain("publish_records_unique_ask_work_item_step_idx");
    expect(publishIndexNames).toContain("publish_records_unique_check_run_work_item_step_idx");
  });

  it("is idempotent under concurrent runs (advisory lock)", async () => {
    await expect(Promise.all([runMigrations(pool), runMigrations(pool)])).resolves.toHaveLength(2);
  });
});
