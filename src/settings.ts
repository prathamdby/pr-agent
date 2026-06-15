/** Environment variable names and code constants (see `docs/configuration.md`). */
export const ENV = {
  PORT: "PORT",
  ROLE: "ROLE",
  GITHUB_APP_ID: "GITHUB_APP_ID",
  GITHUB_APP_PRIVATE_KEY: "GITHUB_APP_PRIVATE_KEY",
  WEBHOOK_SECRET: "WEBHOOK_SECRET",
  DATABASE_URL: "DATABASE_URL",
  AGENT_PROVIDER: "AGENT_PROVIDER",
  PI_PROVIDER: "PI_PROVIDER",
  PI_MODEL: "PI_MODEL",
  MAX_TOOL_ROUNDS: "MAX_TOOL_ROUNDS",
  PROVIDER_PROMPT_TIMEOUT_MS: "PROVIDER_PROMPT_TIMEOUT_MS",
  MAX_REVIEW_PUBLISH_ATTEMPTS: "MAX_REVIEW_PUBLISH_ATTEMPTS",
  MAX_REVIEW_PUBLISH_CALLS: "MAX_REVIEW_PUBLISH_CALLS",
  REVIEW_MIN_CONFIDENCE: "REVIEW_MIN_CONFIDENCE",
  REVIEW_CONCURRENCY: "REVIEW_CONCURRENCY",
  ASK_CONCURRENCY: "ASK_CONCURRENCY",
  ACK_CONCURRENCY: "ACK_CONCURRENCY",
  DESCRIPTION_CONCURRENCY: "DESCRIPTION_CONCURRENCY",
  TRIAGE_CONCURRENCY: "TRIAGE_CONCURRENCY",
  MAX_TOOL_ROUNDS_DESCRIBE: "MAX_TOOL_ROUNDS_DESCRIBE",
  MAX_TOOL_ROUNDS_TRIAGE: "MAX_TOOL_ROUNDS_TRIAGE",
  MAX_TRIAGE_FIXES_PER_RUN: "MAX_TRIAGE_FIXES_PER_RUN",
  DESCRIPTION_GENERATE_TITLE: "DESCRIPTION_GENERATE_TITLE",
  SLASH_ALLOWED_ASSOCIATIONS: "SLASH_ALLOWED_ASSOCIATIONS",
  QUEUE_RETRY_LIMIT: "QUEUE_RETRY_LIMIT",
  QUEUE_RETRY_DELAY_SECONDS: "QUEUE_RETRY_DELAY_SECONDS",
  QUEUE_RETRY_DELAY_MAX_SECONDS: "QUEUE_RETRY_DELAY_MAX_SECONDS",
  QUEUE_EXPIRE_IN_SECONDS: "QUEUE_EXPIRE_IN_SECONDS",
  QUEUE_HEARTBEAT_SECONDS: "QUEUE_HEARTBEAT_SECONDS",
  QUEUE_POLLING_INTERVAL_SECONDS: "QUEUE_POLLING_INTERVAL_SECONDS",
  QUEUE_RETENTION_SECONDS: "QUEUE_RETENTION_SECONDS",
  QUEUE_DELETE_AFTER_SECONDS: "QUEUE_DELETE_AFTER_SECONDS",
  SHUTDOWN_DRAIN_TIMEOUT_SECONDS: "SHUTDOWN_DRAIN_TIMEOUT_SECONDS",
  WEBHOOK_EVENTS_RETENTION_SECONDS: "WEBHOOK_EVENTS_RETENTION_SECONDS",
  AGENT_WORK_RETENTION_SECONDS: "AGENT_WORK_RETENTION_SECONDS",
  RETENTION_CRON: "RETENTION_CRON",
  RETENTION_ENABLED: "RETENTION_ENABLED",
  INSTALLATION_GROUP_CONCURRENCY: "INSTALLATION_GROUP_CONCURRENCY",
  MAX_ASK_TOOL_ROUNDS: "MAX_ASK_TOOL_ROUNDS",
  MAX_ASK_FINALIZE_ROUNDS: "MAX_ASK_FINALIZE_ROUNDS",
  WEBHOOK_MAX_BODY_BYTES: "WEBHOOK_MAX_BODY_BYTES",
  WEBHOOK_TIMEOUT_MS: "WEBHOOK_TIMEOUT_MS",
  CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
  ENABLE_REVIEW_LABELS_EFFORT: "ENABLE_REVIEW_LABELS_EFFORT",
  ENABLE_REVIEW_LABELS_SECURITY: "ENABLE_REVIEW_LABELS_SECURITY",
  ENABLE_THREAD_REPLIES: "ENABLE_THREAD_REPLIES",
  ENABLE_REVIEW_COMMIT_STATUS: "ENABLE_REVIEW_COMMIT_STATUS",
  DESCRIPTION_AUTO_ACTIONS: "DESCRIPTION_AUTO_ACTIONS",
  MAX_PR_FILES_LISTED: "MAX_PR_FILES_LISTED",
  MAX_PR_FILES_PATCH_BYTES: "MAX_PR_FILES_PATCH_BYTES",
  LOG_LEVEL: "LOG_LEVEL",
  LOG_MAX_WIDE_EVENTS: "LOG_MAX_WIDE_EVENTS",
  LOG_PRETTY: "LOG_PRETTY",
  LOG_REDACT: "LOG_REDACT",
  CURSOR_API_KEY: "CURSOR_API_KEY",
  REVIEW_INJECT_ANCHOR_MENU: "REVIEW_INJECT_ANCHOR_MENU",
  REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT: "REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT",
  REVIEW_ANCHOR_MENU_MAX_FILES: "REVIEW_ANCHOR_MENU_MAX_FILES",
  REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE: "REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE",
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS: "LOCAL_WORKSPACE_CLONE_TIMEOUT_MS",
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS: "LOCAL_WORKSPACE_FETCH_TIMEOUT_MS",
  LOCAL_WORKSPACE_SEARCH_MAX_FILES: "LOCAL_WORKSPACE_SEARCH_MAX_FILES",
  LOCAL_WORKSPACE_MAX_FILE_BYTES: "LOCAL_WORKSPACE_MAX_FILE_BYTES",
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES: "LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES",
  LOCAL_WORKSPACE_MAX_DIFF_BYTES: "LOCAL_WORKSPACE_MAX_DIFF_BYTES",
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES: "LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES",
  LOCAL_WORKSPACE_MAX_FETCH_BYTES: "LOCAL_WORKSPACE_MAX_FETCH_BYTES",
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB: "LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB",
  LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS: "LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  GOOGLE_GENERATIVE_AI_API_KEY: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

/** Default values for env-backed settings (see `docs/configuration.md`). */

export const DEFAULT_PORT = 3000;
export const DEFAULT_ROLE = "web" as const;

export const DEFAULT_AGENT_PROVIDER = "pi" as const;
export const DEFAULT_PI_PROVIDER = "openai";
export const DEFAULT_PI_MODEL = "gpt-4o-mini";
export const DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS = 300_000;

export const DEFAULT_MAX_TOOL_ROUNDS = 24;
export const DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS = 3;
export const DEFAULT_MAX_REVIEW_PUBLISH_CALLS = 2;
export const DEFAULT_REVIEW_MIN_CONFIDENCE = 1;

export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const DEFAULT_ASK_CONCURRENCY = 1;
export const DEFAULT_ACK_CONCURRENCY = 2;
export const DEFAULT_DESCRIPTION_CONCURRENCY = 1;
export const DEFAULT_TRIAGE_CONCURRENCY = 1;

export const DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE = 16;
export const DEFAULT_MAX_TOOL_ROUNDS_TRIAGE = 32;
export const DEFAULT_MAX_TRIAGE_FIXES_PER_RUN = 10;
export const DEFAULT_DESCRIPTION_GENERATE_TITLE = false;
export const DEFAULT_SLASH_ALLOWED_ASSOCIATIONS = "OWNER,MEMBER,COLLABORATOR";

export const DEFAULT_QUEUE_RETRY_LIMIT = 3;
export const DEFAULT_QUEUE_RETRY_DELAY_SECONDS = 30;
export const DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS = 300;
export const DEFAULT_QUEUE_EXPIRE_IN_SECONDS = 3600;
export const DEFAULT_QUEUE_HEARTBEAT_SECONDS = 60;
export const DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS = 0.5;
export const DEFAULT_QUEUE_RETENTION_SECONDS = 1_209_600;
export const DEFAULT_QUEUE_DELETE_AFTER_SECONDS = 604_800;
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS = 25;

export const DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS = 2_592_000;
export const DEFAULT_AGENT_WORK_RETENTION_SECONDS = 2_592_000;
export const DEFAULT_RETENTION_CRON = "17 3 * * *";
export const DEFAULT_RETENTION_ENABLED = true;
export const DEFAULT_INSTALLATION_GROUP_CONCURRENCY = 2;

export const DEFAULT_MAX_ASK_TOOL_ROUNDS = 12;
export const DEFAULT_MAX_ASK_FINALIZE_ROUNDS = 2;

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 25_000_000;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export const DEFAULT_CONTEXT7_API_KEY = "";
export const DEFAULT_CURSOR_API_KEY = "";

export const DEFAULT_ENABLE_REVIEW_LABELS_EFFORT = true;
export const DEFAULT_ENABLE_REVIEW_LABELS_SECURITY = false;
export const DEFAULT_ENABLE_THREAD_REPLIES = false;
export const DEFAULT_ENABLE_REVIEW_COMMIT_STATUS = false;
export const DEFAULT_DESCRIPTION_AUTO_ACTIONS = "opened";

export const DEFAULT_MAX_PR_FILES_LISTED = 300;
export const DEFAULT_MAX_PR_FILES_PATCH_BYTES = 500_000;

export const DEFAULT_LOG_LEVEL = "info" as const;
export const DEFAULT_LOG_MAX_WIDE_EVENTS = 128;
export const DEFAULT_LOG_REDACT = true;

export const DEFAULT_REVIEW_INJECT_ANCHOR_MENU = true;
export const DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT = true;
export const DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES = 40;
export const DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE = 20;

export const DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS = 60_000;
export const DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_FILES = 500;
export const DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES = 1_000_000;
export const DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES = 50_000_000;
export const DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES = 5_000_000;
export const DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES = 500_000_000;
export const DEFAULT_LOCAL_WORKSPACE_MAX_FETCH_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB = 1_000_000;
export const DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS = 86_400;

/** Agent work (pg-boss) queue names. */
export const ACK_QUEUE = "agent-work-ack";
export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const DESCRIPTION_QUEUE = "agent-work-description";
export const TRIAGE_QUEUE = "agent-work-triage";
export const RETENTION_QUEUE = "agent-work-retention";
export const RETENTION_QUEUE_POLLING_INTERVAL_SECONDS = 60;
export const ACK_DEAD_LETTER_QUEUE = "agent-work-ack-dead";
export const REVIEW_DEAD_LETTER_QUEUE = "agent-work-review-dead";
export const ASK_DEAD_LETTER_QUEUE = "agent-work-ask-dead";
export const DESCRIPTION_DEAD_LETTER_QUEUE = "agent-work-description-dead";
export const TRIAGE_DEAD_LETTER_QUEUE = "agent-work-triage-dead";
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
export const AUTOMATED_REVIEW_LENS = "review" as const;
export const DESCRIPTION_PUBLISH_LENS = "description" as const;
export const ASK_PUBLISH_LENS = "ask" as const;
export const TRIAGE_PUBLISH_LENS = "triage" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;

/** pi-ai metadata when mapping Cursor.models.list() items. */
export const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;
export const CURSOR_DEFAULT_MAX_TOKENS = 16_384;

export const LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY = 32;
export const LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE = 256;
export const PR_REPOSITORY_VIEW_RELEASE_GRACE_MS = 60_000;

/** PR description agent block (merge-by-header). */
export const DESCRIPTION_AGENT_HEADER = "## PR Agent Description";
export const DESCRIPTION_BODY_SEPARATOR = "\n\n___\n\n";
export const DESCRIPTION_FAILURE_MESSAGE =
  "PR Agent could not generate a description for this pull request after retries. Try `/describe` again later.";
export const DESCRIPTION_ALREADY_IN_PROGRESS =
  "A `/describe` run is already queued or in progress for this pull request.";
export const DESCRIPTION_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitDescription now with a complete DescriptionPayload.";
export const DESCRIPTION_VALIDATION_REPAIR_ROUNDS = 3;
export const DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS = 2;
export const MAX_DESCRIPTION_PAYLOAD_PR_FILES = 20;

/** PR triage agent block (upserted by sentinel). */
export const TRIAGE_SUMMARY_SENTINEL = "## PR Agent Triage";
export const TRIAGE_ALREADY_IN_PROGRESS =
  "A `/triage` run is already queued or in progress for this pull request.";
export const TRIAGE_FAILURE_MESSAGE =
  "PR Agent could not complete the triage run after retries. Try `/triage` again later.";
export const TRIAGE_NO_PRIOR_FINDINGS =
  "No prior PR Agent inline findings to triage on this pull request. Run `/review` first.";
export const TRIAGE_NO_ELIGIBLE_FINDINGS =
  "No triage-eligible unresolved PR Agent inline findings on this pull request.";
export const TRIAGE_THREAD_NOT_ELIGIBLE =
  "This thread is not a triage-eligible PR Agent finding (wrong thread, already resolved, or not from a bot review).";
export const TRIAGE_FULL_RUN_IN_PROGRESS =
  "A full-PR `/triage` run is already queued or in progress for this pull request.";
export const TRIAGE_INLINE_USAGE_HINT =
  "Reply with `/triage` inside a PR Agent inline finding thread, or post `/triage` on the PR conversation to triage all findings.";
export const TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED =
  "All prior PR Agent inline findings on this pull request are already resolved.";
export const TRIAGE_FORK_PR_NOTICE =
  "PR Agent cannot push fixes to fork branches. Triage ran in report-only mode.";
export const TRIAGE_STALE_HEAD_NOTICE =
  "The pull request head changed while triage was running; no fixes were pushed. Re-run `/triage`.";
export const TRIAGE_THREAD_RESOLUTION_NOTICE =
  "Some fixed or already-resolved findings could not be matched to GitHub review threads, so their thread replies were skipped.";
export const TRIAGE_VALIDATION_REPAIR_ROUNDS = 3;
export const TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS = 2;
export const MAX_TRIAGE_FINDINGS = 128;
export const TRIAGE_VERDICT_EVIDENCE_MAX_CHARS = 500;
export const TRIAGE_SKIP_REASON_MAX_CHARS = 300;
export const TRIAGE_COMMIT_SUBJECT_MAX_CHARS = 50;
export const TRIAGE_COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
  "style",
  "perf",
] as const;
export const TRIAGE_COMMIT_MAX_FILES = 20;
/** Staged-diff size cap per commitFix call (added + removed lines). */
export const TRIAGE_MAX_COMMIT_DIFF_LINES = 200;
export const TRIAGE_NEW_FILE_MAX_BYTES = 32_768;

/** Review output sentinels and labels. */
export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const SECURITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Security Review";
export const QUALITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Quality Review";
export const TESTS_REVIEW_SUMMARY_SENTINEL = "## PR Agent Tests Review";
export const LABEL_REVIEW_EFFORT_PREFIX = "Review effort ";
export const LABEL_SECURITY_EFFORT_PREFIX = "Security effort ";
export const LABEL_QUALITY_EFFORT_PREFIX = "Quality effort ";
export const LABEL_TESTS_EFFORT_PREFIX = "Tests effort ";
export const LABEL_SECURITY_CONCERN = "Possible security concern";
export const LABEL_CATEGORY_PREFIX = "Category: ";
export const REVIEW_WALKTHROUGH_MAX_FILES = 40;
export const REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE = 50;

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const SECURITY_REVIEW_POINTER_BODY =
  "See the security review summary in the PR conversation.";
export const QUALITY_REVIEW_POINTER_BODY =
  "See the code-quality review summary in the PR conversation.";
export const TESTS_REVIEW_POINTER_BODY =
  "See the proposed test cases summary in the PR conversation.";
export const REPEAT_NO_BUGS_PREFIX = "No bugs found";
export const AGENT_FIX_PROMPT_PREAMBLE =
  "Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.";
export const AGENT_FIX_PROMPT_ACCORDION_SUMMARY = "Fix all findings (agent prompt)";
export const REVIEW_POINTER_BODY_MAX_CHARS = 60_000;
export const AGENT_FIX_PROMPT_TRUNCATION_SUFFIX =
  "\n...[truncated; see inline threads and PR summary]";

/** Review comment formatting (GitHub markdown). */
/** Effort 2–3 both map to "Moderate" on the 1–5 scale. */
export const REVIEW_EFFORT_WORDS = [
  "Light",
  "Moderate",
  "Moderate",
  "Substantial",
  "Heavy",
] as const;
export const REVIEW_OVERVIEW_ALERT = "NOTE";
export const REVIEW_FAILURE_ALERT = "CAUTION";
export const REVIEW_PROGRESS_NOTE = "Review in progress on the latest commit.";
export const REVIEW_FINDING_FOOTNOTE_INLINE = "Fix prompt on the inline thread.";
export const REVIEW_FINDING_FOOTNOTE_SUMMARY = "Expand Prompt to fix below (summary-only).";
export const REVIEW_FINDINGS_NONE = "No issues on this pass.";
export const REVIEW_POINTER_NOTE_LEAD =
  "Full review is in the PR conversation. Expand below to copy fixes for your coding agent.";
export const REVIEW_SECURITY_DEFAULT = "No security concerns identified";
export const REVIEW_PROGRESS_SOURCE_AUTO = "Pull request update";
export const REVIEW_PROGRESS_SOURCE_SLASH = "slash command";

/** Lightweight review completion (docs-only auto-review skip). */
export const LIGHTWEIGHT_REVIEW_COMPLETION_LEAD =
  "No deep review run: this automated review was skipped because the change set is documentation-only.";
export const LIGHTWEIGHT_REVIEW_COMPLETION_REASON = "Documentation-only change set";
export const LIGHTWEIGHT_REVIEW_COMPLETION_HINT = "Use /review for a full review.";

/** Review budget tier thresholds (advisory hints only). */
export const REVIEW_SIZE_TIER_SMALL_MAX_FILES = 10;
export const REVIEW_SIZE_TIER_MEDIUM_MAX_FILES = 50;
export const REVIEW_SIZE_TIER_LARGE_MIN_CHANGES = 2000;

/** Per-repo review policy file at checkout root. */
export const REPO_POLICY_FILENAME = ".pr-agent.yml";
export const MAX_REPO_POLICY_BYTES = 32 * 1024;
export const MAX_REPO_POLICY_TONE_CHARS = 500;
export const MAX_REPO_POLICY_PATH_PATTERN_CHARS = 200;
export const MAX_REPO_POLICY_INSTRUCTION_CHARS = 1000;
export const MAX_REPO_POLICY_PATH_INSTRUCTIONS = 20;

/** Risk path hints for trusted review context (prompt guidance). */
export const REVIEW_RISK_PATH_PATTERNS: Readonly<
  Record<"auth" | "migration" | "config" | "security" | "test", readonly RegExp[]>
> = {
  auth: [/(^|\/)auth(?:\/|$)/i, /(^|\/)login(?:\/|$)/i, /(^|\/)session(?:\/|$)/i],
  migration: [/(^|\/)migrations?\//i, /\.sql$/i],
  config: [
    /(^|\/)\.env/i,
    /(^|\/)config(?:\/|\.)/i,
    /(^|\/)settings(?:\/|\.)/i,
    /\.ya?ml$/i,
    /\.json$/i,
  ],
  security: [/(^|\/)security(?:\/|$)/i, /(^|\/)crypto(?:\/|$)/i, /(^|\/)secrets?\//i],
  test: [/(^|\/)test(?:s)?\//i, /\.test\.[a-z]+$/i, /\.spec\.[a-z]+$/i],
};

export const MAX_REVIEW_FOLLOW_UPS = 5;
export const REVIEW_EFFORT_MIN = 1;
export const REVIEW_EFFORT_MAX = 5;

/** ReviewPayload public field size limits (unlimited finding count; bounded text). */
export const REVIEW_FINDING_TITLE_MAX_CHARS = 80;
export const REVIEW_FINDING_DETAIL_MAX_CHARS = 4000;
export const REVIEW_FINDING_FIX_PROMPT_MAX_CHARS = 2000;
export const REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS = 2000;
export const REVIEW_DROPPED_INLINE_NOTE_MAX_FINDINGS = 10;
export const REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const MAX_PRIOR_INLINE_FEEDBACK_THREADS = 20;
export const MAX_PRIOR_INLINE_REPLY_CHARS = 500;
export const REVIEW_OVERVIEW_MAX_CHARS = 8000;
export const REVIEW_OVERVIEW_COMPACT_MAX_CHARS = 500;
export const REVIEW_SECURITY_CONCERNS_MAX_CHARS = 4000;
export const REVIEW_FOLLOW_UP_MAX_CHARS = 2000;
export const REVIEW_SUMMARY_BODY_MAX_CHARS = 60_000;
export const REVIEW_SUMMARY_COMPACTION_NOTE =
  "Some finding details were shortened to fit GitHub comment size limits. See inline threads where posted.";
export const REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX =
  "finding(s) omitted from this summary due to GitHub comment size limits — see inline threads where posted.";
/** Soft sanity ceiling on findings count (not a review-quality cap). */
export const MAX_REVIEW_PAYLOAD_FINDINGS = 128;
/** Max inline review threads attempted in one GitHub review submission. */
export const MAX_INLINE_REVIEW_COMMENTS = 50;

export const REVIEW_SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const;

export const PROSE_ONLY_NUDGE =
  "You replied with text only. Call submitReview now with a complete ReviewPayload (required).";

export const PUBLISH_RECOVERY_ROUNDS = 4;
export const PUBLISH_RECOVERY_PROMPTS = [
  "You ended with a text reply but never called submitReview. Call submitReview exactly once now with a complete ReviewPayload based on your analysis above. Do not continue investigating unless required to fix payload validation.",
  "The structured review was still not published. You must call submitReview now with a valid ReviewPayload. No prose-only replies.",
  "Final publish attempt: call submitReview immediately with your ReviewPayload. This is required to complete the review.",
] as const;

export const VALIDATION_REPAIR_ROUNDS = 3;

export const ASK_RETRY_NUDGE =
  "Answer the question now in plain text based on your investigation above. Do not call more tools unless absolutely required to fix a factual gap.";

export const ASK_FAILURE_MESSAGE =
  "I could not put together a confident answer from the PR and repo tools available. Try rephrasing the question, narrowing it to a file or symbol, or run `/review` for a full pass.";

export const PUBLISH_BUDGET_EXHAUSTED_MESSAGE =
  "Review publish budget exhausted for this run. Do not call submitReview again.";

/** Review harness: step enforcement when diff cache is empty at submitReview. */
export const REVIEW_DIFF_CACHE_REQUIRED_MESSAGE =
  "Call listChangedFiles and getWorkspaceDiff first; diff index is empty so inline anchors cannot be validated.";

/** Review harness: anchor menu block header (untrusted user content). */
export const REVIEW_ANCHOR_MENU_BLOCK_LABEL = "anchor_menu";

/**
 * ReviewValidationFailureKind — taxonomy for Zod validation failures on ReviewPayload.
 * Used by review harness metrics and repair prompts.
 */
export type ReviewValidationFailureKind =
  | "missing_field"
  | "wrong_type"
  | "enum_mismatch"
  | "string_too_short"
  | "array_too_long"
  | "out_of_range"
  | "custom_predicate"
  | "other";

/** Review phase names for harness metrics (see CONTEXT.md). */
export type ReviewPhase =
  | "investigation"
  | "pre_submit"
  | "validation_repair"
  | "publish_recovery"
  | "plaintext_fallback";

/** Ask command safety and UX. */
export const ASK_META_REFUSAL =
  "I can only answer questions about this PR's code. I can't share bot configuration, credentials, or internal instructions.";

export const MAX_ASK_QUESTION_CHARS = 8192;

export const ASK_USAGE_HINT =
  "Usage: `/ask <your question>` — ask about this PR or a specific line of code.";

export function askQuestionTooLongHint(maxChars: number = MAX_ASK_QUESTION_CHARS): string {
  return `Your question exceeds the ${maxChars} character limit. Shorten it or reference files by path instead of pasting large blocks.`;
}

export const BOT_META_PATTERNS: readonly RegExp[] = [
  /\b(your|the)\s+system\s+prompt\b/i,
  /\brepeat\s+(everything|all)\s+above\b/i,
  /\brepeat\s+your\s+(instructions|rules|prompt)\b/i,
  /\bwhat\s+(model|llm)\s+are\s+you\b/i,
  /\bwhat\s+(provider|pi[_-]?provider)\s+do\s+you\s+use\b/i,
  /\b(your|the)\s+(openai|anthropic|google)\s+api\s+key\b/i,
  /\bwhat\s+is\s+your\s+(database_url|webhook_secret|github_app(?:_id|_private_key)?)\b/i,
  /\b(show|reveal|print|output|dump|tell\s+me)\s+.{0,30}\b(your\s+)?(prompt|instructions|system\s+message)\b/i,
  /\bhow\s+are\s+you\s+(deployed|hosted|configured)\b/i,
  /\b(bot|agent)\s+(configuration|credentials|secrets|environment)\b/i,
  /(?:^|\n)\s*ignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/i,
];

export const BOT_SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/gi,
  /(token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
  /\b[Aa]uthorization\s*:\s*.+/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bgh[oru]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bpostgres(?:ql)?:\/\/\S+/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bDATABASE_URL\s*=\s*\S+/gi,
  /\b(?:OPENAI|ANTHROPIC|GOOGLE_GENERATIVE_AI|CURSOR|CONTEXT7)_API_KEY\s*=\s*\S+/gi,
  /\bAWS_SECRET_ACCESS_KEY\s*[=:]\s*\S+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
];

export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.env\.[^/]+$/i,
  /\.pem$/i,
  /(^|\/)id_rsa(?:\.pub)?$/i,
  /(^|\/)id_ed25519(?:\.pub)?$/i,
  /(^|\/)id_ecdsa(?:\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)secrets?\./i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.dockercfg$/i,
  /\.key$/i,
];

export const ASK_TOOLS_WITH_OWNER_REPO = new Set([
  "getPullRequest",
  "listPullRequests",
  "listPullRequestFiles",
  "listPullRequestReviews",
  "getFileContent",
  "listCommits",
  "getCommit",
  "getBlame",
  "getRepository",
  "listBranches",
]);

export const ASK_TOOLS_WITH_PULL_NUMBER = new Set([
  "getPullRequest",
  "listPullRequestFiles",
  "listPullRequestReviews",
]);

/** GitHub API / token handling. */
export const TOKEN_FRESHNESS_BUFFER_MS = 60_000;
export const INSTALLATION_TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000;
export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 3;
export const GITHUB_PULL_REQUEST_FILES_API_MAX_FILES = 3_000;
export const COMMENTS_PAGE_SIZE = 100;
export const COMMENT_PAGINATION_MAX_PAGES = 20;

export const POSTGRES_POOL_MAX = 10;
export const POSTGRES_IDLE_TIMEOUT_MS = 30_000;
export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;
export const POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;
export const GITHUB_WEBHOOK_RESPONSE_MARGIN_MS = 2_000;

export const TOKEN_EXPIRED_TOOL_MESSAGE =
  "Installation token is near expiry; cannot call GitHub tools for this review run. Call submitReview with your current analysis if possible.";

export const GITHUB_REACTION_EYES = "eyes" as const;

/** Context7 integration. */
export const CONTEXT7_BASE_URL = "https://context7.com/api";

/** Cursor SDK MCP bridge (inline provider). */
export const CURSOR_MCP_BIND_HOST = "127.0.0.1";
export const CURSOR_MCP_TOKEN_BYTES = 32;
export const CURSOR_MCP_SERVER_START_TIMEOUT_MS = 5_000;
export const CURSOR_MAX_PORT_RETRIES = 5;
export const CURSOR_MCP_SERVER_NAME = "pr-agent";

/** Logging. */
export const MAX_LOG_MESSAGE_LEN = 2_000;
export const MAX_LOG_REDACTION_SCAN_LEN = MAX_LOG_MESSAGE_LEN * 4;

/** Slash command help (scheduler ack replies). */
export const SLASH_HELP_BODY = [
  "### PR Agent help",
  "",
  "Commands (first line of a **new** comment):",
  "- `/help` — show this message",
  "- `/ask <question>` — ask about this PR or a specific line of code",
  "- `/describe` — generate or refresh the PR title/body summary (also runs automatically on PR open)",
  "- `/review` — general bug-and-correctness review (also runs automatically on PR open/sync)",
  "- `/review-security` — deep security review (DeepSec-style; trigger-only, not auto-run)",
  "- `/review-quality` — deep code-quality review (maintainability; trigger-only, not auto-run)",
  "- `/review-tests` — draft missing test cases for the PR's changes (trigger-only, not auto-run)",
  "- `/triage` — fix earlier PR Agent findings on this PR: commits and pushes minimal fixes to the PR branch, resolves fixed threads (trigger-only; same-repo PRs). Post on the PR conversation to triage all findings, or reply `/triage` inside a bot inline finding thread to triage that finding only.",
  "",
  "Notes:",
  "- Automated `/describe` runs on PR actions listed in `DESCRIPTION_AUTO_ACTIONS` (default `opened` only); `/review` runs on `opened` / `synchronize` / `reopened`.",
  "- `/describe` merges generated content below the PR Agent description header; your text above that header is preserved.",
  "- `/review`, `/review-security`, `/review-quality`, and `/review-tests` can each leave summary comments on the same PR (different sentinels).",
  "- `/ask` answers one question at a time; it does not remember prior `/ask` commands.",
  "- Some security issues may appear in both passes; pick the command that matches your question.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

/** Database migrations path (relative to process cwd). */
export const MIGRATIONS_DIR_NAME = "migrations";

/** Stable key for the pg_advisory_lock that serializes runMigrations across processes. */
export const MIGRATION_ADVISORY_LOCK_KEY = 4_785_219;

/** Wall-clock budget (ms) for the /ready Postgres ping. */
export const HEALTH_DB_PING_TIMEOUT_MS = 2_000;
