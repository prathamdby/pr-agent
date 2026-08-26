import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  claimSummaryCommentCreation,
  recordAskPublishStep,
} from "../../src/agentWork/publishRecordRepository.js";
import { persistOperationIntent } from "../../src/agentWork/operationIntentRepository.js";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

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
  "014_slash_active_uniqueness.sql",
  "015_thread_reply_classification.sql",
  "016_agent_runtime_durability.sql",
  "017_agent_events.sql",
  "018_finding_history.sql",
  "019_code_index.sql",
  "020_github_installation_rate_limit_circuits.sql",
  "021_operation_intent_outcome_unknown.sql",
  "022_execution_epoch.sql",
  "023_pr_actor_leases.sql",
  "024_webhook_replay_protection.sql",
  "025_ask_quotas.sql",
  "026_lease_fenced_side_effects.sql",
].toSorted();

function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
}

describe("migrations inventory", () => {
  it("locks expected inventory to the migrations directory", () => {
    expect(EXPECTED_MIGRATIONS).toEqual(migrationFilesOnDisk());
  });
});

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
    const versions = rows.map((r) => r.version).toSorted();
    expect(versions).toEqual(EXPECTED_MIGRATIONS);
    expect(versions).toEqual(migrationFilesOnDisk());
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
    expect(names).toContain("agent_work_items_slash_active_uniqueness_idx");
    expect(names).toContain("agent_work_items_ask_webhook_event_id_uniqueness_idx");
    expect(names).not.toContain("agent_work_items_status_idx");
    expect(names).not.toContain("agent_work_items_status_completed_at_idx");
    expect(names).not.toContain("agent_work_items_installation_status_idx");
    const indexDefs = rows.map((r) => r.indexdef).join("\n");
    expect(indexDefs).toContain("COALESCE(completed_at, updated_at)");
    expect(indexDefs).toContain("staleHeadRescheduled");
    expect(indexDefs).toMatch(/NULLS\s+NOT\s+DISTINCT/i);

    const publishIndexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'publish_records'",
    );
    const publishIndexNames = publishIndexes.rows.map((r) => r.indexname);
    expect(publishIndexNames).toContain("publish_records_work_item_id_idx");
    expect(publishIndexNames).toContain("publish_records_unique_shared_step_idx");
    expect(publishIndexNames).toContain("publish_records_unique_ask_work_item_step_idx");
    expect(publishIndexNames).toContain("publish_records_unique_check_run_work_item_step_idx");
  });

  it("accepts outcome_unknown on operation_intents.status", async () => {
    const { rows } = await pool.query<{ check_clause: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS check_clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'operation_intents'
          AND c.contype = 'c'
          AND c.conname = 'operation_intents_status_check'`,
    );
    expect(rows[0]?.check_clause ?? "").toContain("outcome_unknown");
  });

  it("stores lease epochs on durable intent and publish rows", async () => {
    const operationColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'operation_intents'
          AND column_name = 'lease_epoch'`,
    );
    const publishColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'publish_records'
          AND column_name = 'lease_epoch'`,
    );
    expect(operationColumns.rows).toHaveLength(1);
    expect(publishColumns.rows).toHaveLength(1);
  });

  it("fences matching, stale, and unleased durable writes", async () => {
    const workItemId = randomUUID();
    const resourceKey = `migration-lease-fence/${randomUUID()}#1`;
    const currentEpoch = 9;

    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES ($1, 'review', 'auto', 'running', 'migration-lease-fence', 'r', 1, 1,
               'head', 'review', $2, '{}'::jsonb)`,
      [workItemId, resourceKey],
    );
    await pool.query(
      `INSERT INTO pr_actor_leases (
         resource_key, work_type, lease_epoch, work_item_id, holder_id, expires_at
       )
       VALUES ($1, 'review', $2, $3, 'migration-test-holder', now() + interval '5 minutes')`,
      [resourceKey, currentEpoch, workItemId],
    );

    try {
      const leasedIntent = await persistOperationIntent(pool, {
        workItemId,
        operationKey: "github:leased-intent",
        mutationKind: "github.test",
        leaseEpoch: currentEpoch,
      });
      expect(leasedIntent.leaseEpoch).toBe(currentEpoch);

      await expect(
        persistOperationIntent(pool, {
          workItemId,
          operationKey: "github:stale-intent",
          mutationKind: "github.test",
          leaseEpoch: currentEpoch - 1,
        }),
      ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });

      const unleasedIntent = await persistOperationIntent(pool, {
        workItemId,
        operationKey: "ask:unleased-intent",
        mutationKind: "github.ask_reply",
        detail: { step: "ask_reply" },
        leaseEpoch: null,
      });
      expect(unleasedIntent.leaseEpoch).toBeNull();

      const summaryResource = `${resourceKey}:summary`;
      await expect(
        claimSummaryCommentCreation(pool, workItemId, summaryResource, "review", currentEpoch),
      ).resolves.toBe(true);
      await expect(
        claimSummaryCommentCreation(
          pool,
          workItemId,
          `${resourceKey}:stale-summary`,
          "review",
          currentEpoch - 1,
        ),
      ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
      await expect(
        claimSummaryCommentCreation(
          pool,
          workItemId,
          `${resourceKey}:unleased-summary`,
          "review",
          null,
        ),
      ).resolves.toBe(true);

      await recordAskPublishStep(pool, {
        workItemId,
        resourceKey: `${resourceKey}:ask`,
        step: "ask_reply",
        githubId: 123,
        leaseEpoch: null,
      });

      const { rows: intentRows } = await pool.query<{ lease_epoch: string | null }>(
        `SELECT lease_epoch FROM operation_intents
          WHERE work_item_id = $1 ORDER BY operation_key`,
        [workItemId],
      );
      expect(intentRows.map((row) => row.lease_epoch)).toEqual([null, String(currentEpoch)]);

      const { rows: publishRows } = await pool.query<{
        resource_key: string;
        lease_epoch: string | null;
      }>(
        `SELECT resource_key, lease_epoch FROM publish_records
          WHERE work_item_id = $1 ORDER BY resource_key`,
        [workItemId],
      );
      expect(publishRows).toEqual([
        { resource_key: `${resourceKey}:ask`, lease_epoch: null },
        { resource_key: `${resourceKey}:summary`, lease_epoch: String(currentEpoch) },
        { resource_key: `${resourceKey}:unleased-summary`, lease_epoch: null },
      ]);
    } finally {
      await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it("is idempotent under concurrent runs (advisory lock)", async () => {
    await expect(Promise.all([runMigrations(pool), runMigrations(pool)])).resolves.toHaveLength(2);
  });
});
