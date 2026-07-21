/** Review output sentinels and labels. */
export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const LABEL_REVIEW_EFFORT_PREFIX = "Review effort ";
export const LABEL_SECURITY_CONCERN = "Possible security concern";
export const LABEL_CATEGORY_PREFIX = "Category: ";
export const REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE = 50;

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const REPEAT_NO_BUGS_PREFIX = "No bugs found";
export const AGENT_FIX_PROMPT_PREAMBLE =
  "Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, and keep changes minimal.";
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
export const REVIEW_SECURITY_DEFAULT = "None found on this pass";
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

/** Per-repo review policy directory of `.mdc` rules at checkout root. */
export const REPO_POLICY_DIRNAME = ".pr-agent";
export const REPO_POLICY_EXTENSION = ".mdc";
export const MAX_REPO_POLICY_BYTES = 32 * 1024;
export const MAX_REPO_POLICY_FILE_BYTES = 8 * 1024;
export const MAX_REPO_POLICY_FILES = 20;
export const MAX_REPO_POLICY_PATH_PATTERN_CHARS = 200;
export const MAX_REPO_POLICY_INSTRUCTION_CHARS = 1000;

/**
 * Root agent-instruction files loaded into review trusted context (parallel to
 * `.pr-agent/*.mdc` repo policy). Order is load/render order.
 */
export const AGENT_INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
export const MAX_AGENT_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_AGENT_INSTRUCTION_FILE_BYTES = 32 * 1024;

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

/** Merge verdict (ADR 0019): model-authored readiness assessment, consistency-clamped. */
export const REVIEW_MERGE_VERDICT_RATIONALE_MAX_CHARS = 300;
export const MERGE_VERDICT_SAFE_TO_MERGE_PATTERNS: readonly RegExp[] = [
  /safe to merge/i,
  /ready to merge/i,
  /good to merge/i,
];
export const REVIEW_MERGE_VERDICT_NO_BLOCKING_FALLBACK = "No blocking findings on this pass";
export const REVIEW_MERGE_VERDICT_BLOCKING_FALLBACK_SUFFIX =
  "blocking finding(s) open on this pass";
export const REVIEW_SUMMARY_BODY_MAX_CHARS = 60_000;
export const REVIEW_SUMMARY_COMPACTION_NOTE =
  "Some finding details were shortened to fit GitHub comment size limits. See inline threads where posted.";
export const REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX =
  "finding(s) omitted from this summary due to GitHub comment size limits — see inline threads where posted.";
export const REVIEW_CHECK_RUN_RESERVATION_STALE_MS = 5 * 60 * 1000;
/** Max wait for a peer (e.g. ack job) to persist a started check run id. */
export const REVIEW_CHECK_RUN_WAIT_FOR_ID_MS = 15_000;
export const REVIEW_CHECK_RUN_WAIT_POLL_MS = 100;

/** Review CI summary (optional gate row): fallbacks when call sites omit wait/cap options. */
export const REVIEW_CI_SUMMARY_WAIT_POLL_MS = 2_000;
export const REVIEW_CI_SUMMARY_MAX_FAILURES = 3;
/** Max bytes of condensed CI log context injected into the CI-summary LLM call. */
export const REVIEW_CI_SUMMARY_LOG_MAX_BYTES = 24_000;
/** Max characters kept from a single Actions job log before cross-job capping. */
export const REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS = 12_000;
/** Max jobs whose logs are downloaded for one CI summary. */
export const REVIEW_CI_SUMMARY_LOG_MAX_JOBS = 3;
/** Max chars for model-authored CI headline / reason / fixHint fields. */
export const REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS = 240;
export const REVIEW_CI_SUMMARY_REASON_MAX_CHARS = 400;
export const REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS = 280;

/** User-visible CI row when Checks API is blocked for the installation. */
export const REVIEW_CI_SUMMARY_GRANT_CHECKS =
  "PR Agent can't see check runs on this head. In the GitHub App settings, set Checks to Read, then run /review again.";

/** User-visible note when Actions API is blocked while CI is failing. */
export const REVIEW_CI_SUMMARY_GRANT_ACTIONS =
  "CI failed, but PR Agent can't download the job logs. Set Actions to Read on the GitHub App so the next summary can explain what broke.";

/** Generic CI row when status fetch fails for a non-permission reason. */
export const REVIEW_CI_SUMMARY_UNAVAILABLE = "CI status unavailable";
/** Soft sanity ceiling on findings count (not a quality-scoring gate). */
export const MAX_REVIEW_PAYLOAD_FINDINGS = 128;
/** Max inline review threads attempted in one GitHub review submission. */
export const MAX_INLINE_REVIEW_COMMENTS = 50;
/** Max incremental inline thread publish calls in one review run. */
export const MAX_THREAD_PUBLISH_CALLS = 8;
/** Max findings one specialist may return in a single findings report (orchestrator V2). */
export const MAX_SPECIALIST_FINDINGS = 20;
/** Total specialist attempts per run: one fresh-session retry plus classified transient retries. */
export const MAX_SPECIALIST_ATTEMPTS = 3;
/** Backoff before a classified rate_limit/timeout specialist retry, indexed by prior transient retries. */
export const SPECIALIST_TRANSIENT_BACKOFF_MS = [1_000, 3_000] as const;
/** Max tool rounds per orchestrator judgment turn (one publish_thread call plus a repair, decision 25). */
export const ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS = 4;
/**
 * Fraction of the pg-boss queue expiry the orchestrated run treats as its hard deadline.
 * The handler must always return before pg-boss can fail + redeliver the job (decision 17).
 */
export const RUN_DEADLINE_BUDGET_FRACTION = 0.8;
/**
 * Bounded poll interval while an orchestrator `session.send` is in flight, and while
 * specialists are pending with no send active: detect cheap run cancel (`shouldCancelRun`)
 * and abort promptly without leaving timers past the run (decision 17/18). Never poll the
 * full stale-head `shouldAbortPublish` gate on this interval.
 */
export const ORCHESTRATOR_SEND_ABORT_POLL_MS = 250;
/**
 * Deterministic per-index dispatch stagger (ms) applied to the four specialist spawns to avoid a
 * five-way provider burst (decision 24). Specialist i waits `i * stagger` before its first send.
 */
export const SPECIALIST_DISPATCH_STAGGER_MS = 2_000;
/**
 * Maintainer-visible note when the orchestrator judgment/synthesis session dies and
 * findings/summary are published deterministically (decision 19).
 */
export const JUDGMENT_DEGRADED_NOTE =
  "Judgment degraded: remaining findings were published without LLM judgment; summary was synthesized deterministically from accepted findings.";

/**
 * Maintainer-visible note when the internal run time budget alone forces deterministic
 * summary publish — distinct from orchestrator send/tool judgment degradation.
 */
export const RUN_DEADLINE_NOTE =
  "Run deadline reached: remaining findings were published from accepted state; summary was synthesized without further LLM judgment.";

export const REVIEW_SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const;

export const PUBLISH_RECOVERY_ROUNDS = 4;

export const VALIDATION_REPAIR_ROUNDS = 3;

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

/** Review agent caps. */
export const MAX_TOOL_ROUNDS = 24;
export const MAX_REVIEW_PUBLISH_ATTEMPTS = 3;
export const MAX_REVIEW_PUBLISH_CALLS = 2;
export const REVIEW_MIN_CONFIDENCE = 1;
/** Must not exceed GITHUB_PULL_REQUEST_FILES_API_MAX_FILES (GitHub pull request files API cap). */
export const MAX_PR_FILES_LISTED = 300;
export const MAX_PR_FILES_PATCH_BYTES = 500_000;
export const REVIEW_CI_SUMMARY_WAIT_MS = 15_000;
export const REVIEW_ANCHOR_MENU_MAX_FILES = 40;
export const REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE = 20;
