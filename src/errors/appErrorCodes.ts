export const APP_ERROR_KINDS = {
  agent: ["session_aborted"],
  agent_work: [
    "ask_quota_bucket_missing",
    "ask_quota_execution_conflict",
    "ask_quota_execution_id_missing",
    "ask_quota_provider_bucket_missing",
    "ask_quota_scope_missing",
    "attempts_exhausted",
    "execution_aborted",
    "invalid_payload",
    "progress_comment_ownership_conflict",
    "thread_mutation_lock_timeout",
  ],
  ask: ["sensitive_path_blocked"],
  ci: ["head_state_lock_missed", "head_state_missing", "head_state_unseeded", "summary_no_json"],
  config: [
    "fallback_model_incomplete",
    "invalid_enum",
    "invalid_github_app_private_key",
    "invalid_number",
    "missing_env",
  ],
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
    "mutation_conflict",
    "mutation_failed",
    "mutation_gate_failed",
    "mutation_outcome_unknown",
    "persist_no_row",
    "recovery_failed",
  ],
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
    "fetch_timeout",
    "fetch_too_large",
    "git_failed",
    "head_sha_mismatch",
    "insufficient_free_space",
    "invalid_sha",
    "path_traversal",
    "search_hit_invalid",
    "sensitive_path",
    "symlink_escape",
    "unsafe_head_ref",
    "unsafe_repo_part",
    "unsafe_root_prefix",
  ],
  provider: ["protocol_invalid", "request_failed"],
  review: [
    "declare_duplicate_validation_failed",
    "finding_batch_invalid",
    "orchestrator_outcome_handler_failed",
    "orchestrator_send_failed",
    "payload_redaction",
    "posted_placement_missing_line",
    "progress_comment_url_required",
    "publish_summary_failed",
    "publish_summary_semantic_validation_failed",
    "publish_summary_validation_failed",
    "publish_thread_failed",
    "publish_thread_overlap_unanswered",
    "publish_thread_source_required",
    "publish_thread_validation_failed",
    "specialist_aborted",
    "specialist_failed",
    "specialist_invalid_report",
    "specialist_promise_rejected",
    "specialist_timeout",
    "stale_head_replacement_exhausted",
    "submit_tool_mismatch",
    "summary_coverage_none",
    "tool_wrong_phase",
    "work_item_id_required",
  ],
  runtime: [
    "session_deadline_exceeded",
    "session_disposed",
    "session_send_failed",
    "storage_pragma_mismatch",
  ],
  state: ["sqlite_pragma_mismatch", "sqlite_version_unsupported", "sqlite_writer_lock_held"],
  settings: [
    "models_json_load_error",
    "models_json_model_not_found",
    "models_json_path_not_found",
    "models_json_unknown_provider_no_catalog",
    "models_json_unresolvable_api",
  ],
  tool: ["input_validation_failed"],
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

export function appErrorCode(shape: AppErrorShape) {
  const code = `${shape.domain}.${shape.kind}`;
  if (!isAppErrorCode(code)) {
    throw new TypeError(`Unknown app error code: ${code}`);
  }
  return ((pinnedReturn: AppErrorCode) => pinnedReturn)(code);
}
