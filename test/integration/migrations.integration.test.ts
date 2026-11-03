import { createPublishContext } from "../../src/agentWork/publishOnce.ts";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { REPORT_OBSTACLE_NAME } from "../../src/agent/feedback/reportObstacle.ts";
import { createFeaturePiSession } from "../../src/agent/runtime/createFeatureSession.ts";
import { createFakePiSession } from "../../src/agent/runtime/fakePiSession.ts";
import type { PiSessionCreateParams } from "../../src/agent/runtime/types.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { claimSummaryCommentCreation } from "../../src/agentWork/publishRecordRepository.ts";
import { persistOperationIntent } from "../../src/agentWork/operationIntentRepository.ts";
import { runMigrations } from "../../src/db/migrations.ts";
import { hasDatabase, integrationPool } from "./db.ts";

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
  "027_verification_slash_active_uniqueness.sql",
  "028_triage_preview_step.sql",
  "029_ask_quota_execution_receipts.sql",
  "030_pr_head_ci_state.sql",
  "031_projection_repair_pending.sql",
  "032_agent_events_recorded_at_index.sql",
  "033_webhook_delivery_duplicates.sql",
  "034_pr_review_lifecycle.sql",
  "035_pr_review_approvals.sql",
  "036_drop_agent_runtime_durability.sql",
  "037_review_run_artifacts.sql",
  "038_github_capabilities.sql",
  "039_agent_traces.sql",
  "040_drop_agent_traces.sql",
  "041_drop_finding_history.sql",
  "042_pr_review_approvals_workflow_start_admits.sql",
  "043_index_usage.sql",
  "044_agent_feedback.sql",
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

  it("keeps review artifact identities indexed without restoring runtime transcripts", async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'review_run_artifacts'",
    );
    const definitions = indexes.rows.map((row) => row.indexdef).join("\n");
    expect(definitions).toContain("(work_item_id, logical_key)");
    expect(definitions).toContain("(work_item_id, artifact_order)");
    const constraints = await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'review_run_artifacts'::regclass",
    );
    expect(constraints.rows.map((row) => row.definition).join("\n")).toContain(
      "REFERENCES agent_work_items(id) ON DELETE CASCADE",
    );
    expect(
      (
        await pool.query(
          "SELECT to_regclass('agent_phase_checkpoints') AS checkpoints, to_regclass('agent_resume_snapshots') AS snapshots",
        )
      ).rows,
    ).toEqual([{ checkpoints: null, snapshots: null }]);
  });

  it("drops the local agent trace tables and keeps work items", async () => {
    const { rows } = await pool.query<{
      spans: string | null;
      parts: string | null;
      blobs: string | null;
      work: string | null;
    }>(
      `SELECT to_regclass('agent_trace_spans') AS spans,
              to_regclass('agent_trace_parts') AS parts,
              to_regclass('agent_trace_blobs') AS blobs,
              to_regclass('agent_work_items') AS work`,
    );
    expect(rows).toEqual([{ spans: null, parts: null, blobs: null, work: "agent_work_items" }]);
  });

  it("drops the finding history table", async () => {
    const { rows } = await pool.query<{ history: string | null }>(
      "SELECT to_regclass('repo_finding_history') AS history",
    );
    expect(rows).toEqual([{ history: null }]);
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
    expect(names).toContain("agent_work_items_owner_repo_head_sha_idx");
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

    const duplicateIndexes = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'webhook_delivery_duplicates'",
    );
    const definitions = duplicateIndexes.rows.map((row) => row.indexdef).join("\n");
    expect(definitions).toContain("(received_at)");
    expect(definitions).not.toContain("(delivery_id, received_at)");
    expect(definitions).not.toContain("(body_sha256, received_at)");
    const droppedIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
      [
        [
          "github_installation_rate_limit_circuits_open_until_idx",
          "webhook_delivery_duplicates_delivery_id_received_at_idx",
          "webhook_delivery_duplicates_body_sha256_received_at_idx",
          "agent_events_install_recorded_idx",
          "github_head_ci_sources_retention_idx",
          "pr_head_ci_state_projection_repair_pending_idx",
        ],
      ],
    );
    expect(droppedIndexes.rows).toEqual([]);
    const leaseIndex = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'pr_actor_leases_work_item_epoch_idx'",
    );
    const leaseIndexDef = leaseIndex.rows.map((row) => row.indexdef).join("\n");
    expect(leaseIndexDef).toContain("(work_item_id, lease_epoch)");
    expect(leaseIndexDef).toMatch(/work_item_id IS NOT NULL/i);
    const lifecycle = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'pr_review_lifecycle'",
    );
    expect(lifecycle.rows.map((row) => row.indexdef).join("\n")).toContain("(webhook_event_id)");
    const constraints = await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'pr_review_lifecycle'::regclass",
    );
    const contract = constraints.rows.map((row) => row.definition).join("\n");
    expect(contract).toContain("PRIMARY KEY (resource_key)");
    expect(contract).toContain("'open'");
    expect(contract).toContain("'closed'");
    expect(contract).toContain("'merged'");
    expect(contract).toContain("ON DELETE SET NULL");
    await runMigrations(pool);
    expect(
      (
        await pool.query("SELECT version FROM schema_migrations WHERE version = $1", [
          "034_pr_review_lifecycle.sql",
        ])
      ).rows,
    ).toHaveLength(1);
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

      await createPublishContext(pool, {
        workItemId,
        resourceKey: `${resourceKey}:ask`,
        step: "ask_reply",
        githubId: 123,
        leaseEpoch: null,
        reviewLens: "ask",
      }).record();

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

  it("stores head CI state and the extra publish-record steps", async () => {
    const table = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pr_head_ci_state'`,
    );
    expect(table.rows).toHaveLength(1);

    const { rows: rollupCheck } = await pool.query<{ check_clause: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS check_clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'pr_head_ci_state'
          AND c.contype = 'c'`,
    );
    const rollupClause = rollupCheck.map((row) => row.check_clause).join(" ");
    expect(rollupClause).toContain("pending");
    expect(rollupClause).toContain("unknown");

    const { rows: stepCheck } = await pool.query<{ check_clause: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS check_clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'publish_records'
          AND c.contype = 'c'
          AND c.conname = 'publish_records_step_check'`,
    );
    const clause = stepCheck[0]?.check_clause ?? "";
    expect(clause).toContain("ci_cell");
    expect(clause).toContain("commit_status");
    expect(clause).toContain("verification_failure");

    const repairCol = await pool.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pr_head_ci_state'
          AND column_name = 'projection_repair_pending'`,
    );
    expect(repairCol.rows).toHaveLength(1);
    expect(repairCol.rows[0]?.column_default).toContain("false");
  });

  it("is idempotent under concurrent runs (advisory lock)", async () => {
    await expect(Promise.all([runMigrations(pool), runMigrations(pool)])).resolves.toHaveLength(2);
  });

  it("stores one obstacle report per reviewer and continues when the database is down", async () => {
    const id = randomUUID();
    const owner = "feedback-it";
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       ) VALUES ($1, 'review', 'auto', 'running', $2, 'app', 12, 7, 'abc', 'review', $3, '{}'::jsonb)`,
      [id, owner, `feedback-it-${id}`],
    );
    const dead = new Pool({
      connectionString: "postgres://127.0.0.1:1/none",
      connectionTimeoutMillis: 5_000,
      max: 1,
    });
    try {
      const cfg = makeTestConfig({ agentEvents: { enabled: false } });
      const sessionContext = {
        pool,
        workItemId: id,
        installationId: 7,
        owner,
        repo: "app",
        prNumber: 12,
        executionId: "execution-1",
        attemptCount: 1,
      };
      const opened = new Map<string, PiSessionCreateParams>();
      const createSession = async (params: PiSessionCreateParams) => {
        opened.set(params.specialistId ?? params.role, params);
        return createFakePiSession(params, () => "").session;
      };
      const dummy: PiTool = {
        name: "execute",
        description: "read",
        parameters: { type: "object", properties: {} },
      };
      const openSpecialist = (specialistId: "security" | "quality" | "tests") =>
        createFeaturePiSession({
          createSession,
          role: "specialist",
          specialistId,
          cfg,
          systemPrompt: "system",
          tools: [dummy],
          executors: { execute: async () => ({ ok: true }) },
          sessionContext:
            specialistId === "tests" ? { ...sessionContext, pool: dead } : sessionContext,
        });
      await openSpecialist("security");
      await openSpecialist("quality");
      await createFeaturePiSession({
        createSession,
        role: "ci_summary",
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        sessionContext,
      });
      await openSpecialist("tests");

      const security = opened.get("security");
      const quality = opened.get("quality");
      const tests = opened.get("tests");
      const quiet = opened.get("ci_summary");
      const securityExecutor = security?.executors[REPORT_OBSTACLE_NAME];
      const qualityExecutor = quality?.executors[REPORT_OBSTACLE_NAME];
      const testsExecutor = tests?.executors[REPORT_OBSTACLE_NAME];
      if (!securityExecutor || !qualityExecutor || !testsExecutor) {
        throw new Error("report_obstacle missing from a specialist session");
      }
      expect(quiet?.tools.map((tool) => tool.name)).not.toContain(REPORT_OBSTACLE_NAME);
      await createFeaturePiSession({
        createSession,
        role: "specialist",
        specialistId: "correctness",
        cfg,
        systemPrompt: "system",
        tools: [dummy],
        executors: { execute: async () => ({ ok: true }) },
      });
      const missingContext = opened.get("correctness")?.executors[REPORT_OBSTACLE_NAME];
      if (!missingContext) throw new Error("report_obstacle missing without run context");

      const call = {
        signal: AbortSignal.timeout(2_000),
      };
      const securityResult = await securityExecutor(
        {
          intent: "Find callers of save().",
          obstacle: "tool",
          subject: "searchWorkspace",
          problem: "Security search returned no hits.",
          expected: "Matches for save( in src/.",
          severity: "blocked",
        },
        { ...call, toolCallId: "call-security" },
      );
      const duplicate = await securityExecutor(
        {
          intent: "Find callers of save().",
          obstacle: "tool",
          subject: "searchWorkspace",
          problem: "This duplicate must not be stored.",
          expected: "Matches for save( in src/.",
          severity: "blocked",
        },
        { ...call, toolCallId: "call-security" },
      );
      const qualityResult = await qualityExecutor(
        {
          intent: "Read the quality rules.",
          obstacle: "prompt",
          subject: "quality prompt",
          problem: "Quality prompt told me to ignore the diff. ghp_abcdefghijklmnopqrst",
          expected: "A rule that points at the changed lines.",
          severity: "degraded",
        },
        { ...call, toolCallId: "call-quality" },
      );

      expect(securityResult).toEqual({ recorded: true });
      expect(duplicate).toEqual({ recorded: true });
      expect(qualityResult).toEqual({ recorded: true });
      expect(JSON.stringify(securityResult)).not.toContain("Quality prompt");
      expect(JSON.stringify(qualityResult)).not.toContain("Security search");

      const { rows } = await pool.query<{
        specialist: string;
        group_key: string;
        model: string;
        provider: string;
        owner: string;
        repo: string;
        pr_number: number;
        session_role: string;
        obstacle: string;
        subject: string;
        intent: string;
        problem: string;
        expected: string;
        severity: string;
        execution_id: string;
        attempt_count: number;
        recorded_at: Date;
      }>(
        `SELECT specialist, group_key, model, provider, owner, repo, pr_number, session_role,
                obstacle, subject, intent, problem, expected, severity, execution_id,
                attempt_count, recorded_at
           FROM agent_feedback
          WHERE work_item_id = $1
          ORDER BY specialist`,
        [id],
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.specialist === "security")).toMatchObject({
        group_key: "tool:searchworkspace",
        owner,
        repo: "app",
        pr_number: 12,
        session_role: "specialist",
        obstacle: "tool",
        subject: "searchWorkspace",
        intent: "Find callers of save().",
        problem: "Security search returned no hits.",
        expected: "Matches for save( in src/.",
        severity: "blocked",
        execution_id: "execution-1",
        attempt_count: 1,
        model: security?.primary.model,
        provider: security?.primary.provider,
      });
      expect(rows.find((row) => row.specialist === "security")?.recorded_at).toBeInstanceOf(Date);
      expect(rows.find((row) => row.specialist === "quality")).toMatchObject({
        group_key: "prompt:quality prompt",
        problem: "Quality prompt told me to ignore the diff. [redacted]",
        severity: "degraded",
        model: quality?.primary.model,
      });

      const invalid = await securityExecutor({}, { ...call, toolCallId: "call-invalid" });
      expect(invalid).toMatchObject({ recorded: false });
      expect(invalid).toHaveProperty("error");
      const afterInvalid = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_feedback WHERE work_item_id = $1",
        [id],
      );
      expect(afterInvalid.rows[0]?.n).toBe(2);

      const started = Date.now();
      const down = await testsExecutor(
        {
          intent: "Read the test file.",
          obstacle: "tool",
          subject: "readWorkspaceFile",
          problem: "The database was down.",
          expected: "A stored report.",
          severity: "noise",
        },
        { ...call, toolCallId: "call-tests" },
      );
      expect(down).toEqual({ recorded: false });
      expect(Date.now() - started).toBeLessThan(2_000);
      const afterDown = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_feedback WHERE work_item_id = $1",
        [id],
      );
      expect(afterDown.rows[0]?.n).toBe(2);
      const unstored = await missingContext(
        {
          intent: "Read the changed test.",
          obstacle: "instruction",
          subject: "review contract",
          problem: "The run had no repository context.",
          expected: "A stored report.",
          severity: "noise",
        },
        { ...call, toolCallId: "call-correctness" },
      );
      expect(unstored).toEqual({ recorded: false });
      const afterMissing = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_feedback WHERE work_item_id = $1",
        [id],
      );
      expect(afterMissing.rows[0]?.n).toBe(2);
    } finally {
      await dead.end();
      await pool.query("DELETE FROM agent_feedback WHERE work_item_id = $1", [id]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [id]);
    }
  });
});
