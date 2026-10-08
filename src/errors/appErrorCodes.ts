/**
 * Closed registry of structured failures. The persisted and logged code string is
 * `${domain}.${kind}`; renaming or adding a kind changes durable `failure_code`
 * values and analytics, so edit this table deliberately.
 */
export const APP_ERROR_KINDS = {
  agent: ["session_aborted"],
  agent_work: [
    "admission_unavailable",
    "ask_conflict_no_row",
    "ask_quota_bucket_missing",
    "ask_quota_bucket_missing_on_release",
    "ask_quota_execution_conflict",
    "ask_quota_execution_id_missing",
    "ask_quota_provider_bucket_missing",
    "ask_quota_receipt_application_unknown",
    "ask_quota_scope_missing",
    "attempts_exhausted",
    "ci_projection_correlation_missing",
    "enqueue_failed",
    "execution_aborted",
    "invalid_payload",
    "lease_watchdog_arm_failed",
    "own_verdict_capacity",
    "own_verdict_invalid",
    "own_verdict_receipt_rejected",
    "pr_actor_lease_lost",
    "progress_comment_ownership_conflict",
    "publish_lens_mismatch",
    "publish_owner_missing",
    "replacement_cancel_rejected",
    "reschedule_enqueue_failed",
    "rescheduled_parent_complete_failed",
    "slash_active_conflict_no_winner",
    "slash_triage_conflict_no_winner",
    "stale_head_marker_persist_failed",
    "stale_head_parent_not_reschedulable",
    "unreachable_insert",
  ],
  ask: ["sensitive_path_blocked"],
  ci: ["head_state_lock_missed", "head_state_missing", "head_state_unseeded", "summary_no_json"],
  code_index: ["snapshot_upsert_failed"],
  codemode: [
    "access_denied",
    "file_not_found",
    "search_truncated",
    "tool_input_invalid",
    "tool_failure",
  ],
  config: [
    "fallback_model_incomplete",
    "invalid_enum",
    "invalid_github_app_private_key",
    "invalid_number",
    "missing_env",
  ],
  context7: ["outbound_policy_rejected", "request_failed", "response_too_large"],
  description: ["publish_superseded", "validation_failed"],
  github: [
    "essential_access_denied",
    "head_sha_mismatch",
    "missing_app_slug",
    "preflight_exhausted",
    "preflight_unavailable",
    "review_check_lookup_incomplete",
    "review_thread_resolution_denied",
  ],
  operation_intent: [
    "description_identity_conflict",
    "mutation_failed",
    "mutation_outcome_unknown",
    "persist_no_row",
    "publish_record_lookup_failed",
    "reconcile_no_row",
    "recovery_failed",
  ],
  pi: ["prompt_idle_timeout"],
  pr_workspace: [
    "commit_body_capitalization",
    "commit_body_invalid_prefix",
    "commit_body_too_many_bullets",
    "commit_body_trailing_period",
    "commit_diff_not_minimal",
    "commit_fix_no_files",
    "commit_fix_too_many_files",
    "commit_identity_invalid",
    "commit_subject_invalid",
    "commit_subject_too_long",
    "commit_subject_trailing_period",
    "fetch_too_large",
    "head_sha_mismatch",
    "insufficient_free_space",
    "invalid_sha",
    "path_traversal",
    "sensitive_path",
    "symlink_escape",
    "unsafe_head_ref",
    "unsafe_repo_part",
    "unsafe_root_prefix",
  ],
  provider: [
    "missing_tool_executor",
    "model_not_found",
    "protocol_invalid",
    "refusal",
    "request_failed",
  ],
  publish_store: ["invalid_detail"],
  review: [
    "deterministic_finding_publish_failed",
    "finding_batch_invalid",
    "orchestrator_model_deadline",
    "orchestrator_outcome_handler_failed",
    "orchestrator_outcome_unhandled",
    "orchestrator_report_handler_failed",
    "orchestrator_run_failed",
    "orchestrator_send_failed",
    "orchestrator_session_create_deadline",
    "orchestrator_session_create_failed",
    "orchestrator_session_retired",
    "orchestrator_stopped",
    "payload_redaction",
    "posted_placement_missing_line",
    "progress_comment_lookup_failed",
    "progress_comment_url_required",
    "progress_lock_capacity",
    "progress_lock_failed",
    "progress_lock_timeout",
    "publish_summary_failed",
    "publish_summary_semantic_validation_failed",
    "publish_summary_validation_failed",
    "publish_thread_failed",
    "publish_thread_source_required",
    "publish_thread_validation_failed",
    "specialist_aborted",
    "specialist_failed",
    "specialist_invalid_report",
    "specialist_not_started",
    "specialist_promise_rejected",
    "specialist_stopped",
    "specialist_timeout",
    "stale_head_replacement_exhausted",
    "submit_tool_mismatch",
    "summary_coverage_none",
    "tool_wrong_phase",
    "work_item_id_required",
  ],
  runtime: ["mid_session_model_switch", "session_disposed", "session_send_failed"],
  settings: [
    "models_json_load_error",
    "models_json_model_not_found",
    "models_json_path_not_found",
    "models_json_unknown_provider_no_catalog",
    "models_json_unresolvable_api",
  ],
  tool: ["input_validation_failed", "submit_rejected"],
  triage: [
    "cancelled",
    "closed_pull_request",
    "commit_fix_duplicate",
    "control_path_blocked",
    "fix_budget_reached",
    "invalid_preview",
    "invalid_stored_push",
    "missing_submit",
    "old_text_ambiguous",
    "old_text_not_found",
    "path_exists",
    "path_not_implicated",
    "preview_push_blocked",
    "sensitive_path_blocked",
    "stale_head_push",
    "symlink_escape_blocked",
    "unknown_thread",
    "unsafe_new_file_blocked",
    "validation_failed",
  ],
  verification: ["missing_submit", "sensitive_path_blocked", "validation_failed"],
  webhook: ["parse_failed"],
} as const satisfies Record<string, readonly string[]>;

export type AppErrorDomain = keyof typeof APP_ERROR_KINDS;

export type AppErrorKind<D extends AppErrorDomain = AppErrorDomain> =
  (typeof APP_ERROR_KINDS)[D][number];

/** Every legal `{domain, kind}` pair as a discriminated union on `domain`. */
export type AppErrorShape = {
  readonly [D in AppErrorDomain]: { readonly domain: D; readonly kind: AppErrorKind<D> };
}[AppErrorDomain];

export type AppErrorCode = {
  readonly [D in AppErrorDomain]: `${D}.${AppErrorKind<D>}`;
}[AppErrorDomain];

const KNOWN_CODES: ReadonlySet<string> = new Set(
  Object.entries(APP_ERROR_KINDS).flatMap(([domain, kinds]) =>
    kinds.map((kind) => `${domain}.${kind}`),
  ),
);

function isAppErrorCode(code: string): code is AppErrorCode {
  return KNOWN_CODES.has(code);
}

export function appErrorCode(shape: AppErrorShape): AppErrorCode {
  const code = `${shape.domain}.${shape.kind}`;
  if (!isAppErrorCode(code)) {
    throw new TypeError(`Unknown app error code: ${code}`);
  }
  return code;
}
