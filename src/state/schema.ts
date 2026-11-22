import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors/appError.ts";

export const APP_STATE_SCHEMA_VERSION = 1;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_key TEXT PRIMARY KEY,
    body_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_body_replays (
    body_hash TEXT PRIMARY KEY,
    delivery_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_key TEXT,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pr_state (
    pr_key TEXT PRIMARY KEY,
    lifecycle_state TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    active_head_sha TEXT,
    active_review_work_id TEXT,
    active_review_source TEXT,
    auto_review_epoch INTEGER NOT NULL DEFAULT 0,
    description_epoch INTEGER NOT NULL DEFAULT 0,
    verification_epoch INTEGER NOT NULL DEFAULT 0,
    triage_epoch INTEGER NOT NULL DEFAULT 0,
    approval_json TEXT,
    selected_verdict_json TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS work_runs (
    work_id TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    lane TEXT NOT NULL,
    lane_epoch INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    current_attempt_no INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    cancel_reason TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS work_runs_status_next_retry_at
    ON work_runs (status, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS work_runs_pr_key_lane_status
    ON work_runs (pr_key, lane, status)`,
  `CREATE TABLE IF NOT EXISTS work_run_attempts (
    work_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    conversation_id TEXT,
    task_id TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    error_json TEXT,
    PRIMARY KEY (work_id, attempt_no)
  )`,
  `CREATE TABLE IF NOT EXISTS publish_intents (
    intent_key TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    work_id TEXT NOT NULL,
    resource_target TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    state TEXT NOT NULL,
    mutation_kind TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    result_json TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS publish_intents_pr_key_resource_target_state
    ON publish_intents (pr_key, resource_target, state)`,
  `CREATE TABLE IF NOT EXISTS publish_records (
    record_key TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    work_id TEXT NOT NULL,
    step TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ask_quota_buckets (
    scope TEXT NOT NULL CHECK (scope IN ('actor', 'repository', 'installation')),
    scope_key TEXT NOT NULL,
    token_balance REAL NOT NULL CHECK (token_balance >= 0),
    last_refill_at INTEGER NOT NULL,
    outstanding_count INTEGER NOT NULL DEFAULT 0 CHECK (outstanding_count >= 0),
    provider_tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (provider_tokens_used >= 0),
    provider_tokens_reserved INTEGER NOT NULL DEFAULT 0 CHECK (provider_tokens_reserved >= 0),
    provider_window_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_key)
  )`,
  `CREATE TABLE IF NOT EXISTS ask_quota_reservations (
    work_item_id TEXT PRIMARY KEY,
    actor_scope_key TEXT NOT NULL,
    repository_scope_key TEXT NOT NULL,
    installation_scope_key TEXT NOT NULL,
    installation_id INTEGER,
    repo_key TEXT,
    trigger_comment_id INTEGER,
    reserved_provider_tokens INTEGER NOT NULL DEFAULT 0,
    provider_usage_known INTEGER NOT NULL DEFAULT 0,
    provider_tokens_used INTEGER NOT NULL DEFAULT 0,
    released_at INTEGER,
    unknown_usage_charged INTEGER NOT NULL DEFAULT 0,
    unknown_usage_window_started_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ask_quota_reservations_trigger
    ON ask_quota_reservations (installation_id, repo_key, trigger_comment_id)
    WHERE trigger_comment_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ask_quota_execution_receipts (
    work_item_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    provider_tokens_used INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (work_item_id, execution_id)
  )`,
  `CREATE TABLE IF NOT EXISTS pr_head_ci_state (
    repo_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    installation_id INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    seeded_at INTEGER,
    repair_pending INTEGER NOT NULL DEFAULT 0,
    next_projection_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo_key, head_sha)
  )`,
  `CREATE INDEX IF NOT EXISTS pr_head_ci_state_next_projection_at
    ON pr_head_ci_state (next_projection_at)`,
  `CREATE TABLE IF NOT EXISTS github_repository_capabilities (
    installation_id INTEGER NOT NULL,
    repo_key TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (installation_id, repo_key)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_circuits (
    installation_id INTEGER PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT,
    pr_key TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

function schemaError(message: string, context: Record<string, unknown>) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({
      domain: "state",
      kind: "sqlite_version_unsupported",
      message,
      context,
    }),
  );
}

export function applyAppStateSchema(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as
    | { readonly user_version?: number }
    | undefined;
  const version = typeof row?.user_version === "number" ? row.user_version : 0;
  if (version > APP_STATE_SCHEMA_VERSION) {
    throw schemaError(
      `app_state.sqlite has user_version ${String(version)}, newer than supported ${String(APP_STATE_SCHEMA_VERSION)}.`,
      { userVersion: version, supported: APP_STATE_SCHEMA_VERSION },
    );
  }
  if (version === APP_STATE_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA user_version = ${String(APP_STATE_SCHEMA_VERSION)}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
