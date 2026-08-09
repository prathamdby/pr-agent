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
/** Progress stub while the review work item is still queued (before the review worker claims it). */
export const REVIEW_PROGRESS_QUEUED_NOTE = "Review queued on the latest commit.";
/** Queued progress stub table label for wait-queue rank among review work items. */
export const REVIEW_PROGRESS_QUEUE_LABEL = "Queue";

/** Sanitize a GitHub login for public progress-stub attribution. */
export function sanitizeGithubLogin(login: string): string {
  const trimmed = login.trim().replace(/^@+/, "");
  if (trimmed.length > 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(trimmed)) {
    return trimmed;
  }
  return "user";
}

/** Why a review progress stub was cancelled (slash `/cancel` vs PR merge). */
export type ReviewCancelAttribution =
  | { readonly kind: "user"; readonly login: string }
  | { readonly kind: "merged" };

/**
 * Progress stub body for a cancelled review (failure-notice layout: alert only).
 * Slash: names the issuer. Merge: states the PR was merged.
 */
export function reviewProgressCancelledNote(attribution: ReviewCancelAttribution): string {
  switch (attribution.kind) {
    case "merged":
      return "PR merged.";
    case "user":
      return `Cancelled by @${sanitizeGithubLogin(attribution.login)}. Run \`/review\` to try again.`;
    default: {
      const exhaustive: never = attribution;
      return exhaustive;
    }
  }
}
export const REVIEW_FINDING_FOOTNOTE_INLINE = "Fix prompt on the inline thread.";
export const REVIEW_FINDING_FOOTNOTE_SUMMARY = "Expand Prompt to fix below (summary-only).";
export const REVIEW_FINDING_FOOTNOTE_SUMMARY_P3 = "Included in Fix all findings below.";
export const REVIEW_FINDINGS_NONE = "No issues on this pass.";
export const REVIEW_POINTER_NOTE_LEAD =
  "Full review is in the PR conversation. Expand below to copy fixes for your coding agent.";
export const REVIEW_SECURITY_DEFAULT = "None found on this pass";
export const REVIEW_PROGRESS_SOURCE_AUTO = "Pull request update";
export const REVIEW_PROGRESS_SOURCE_SLASH = "Slash command";

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
export const REVIEW_FINDING_VIOLATED_RULE_MAX_CHARS = 80;
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
/** Soft sanity ceiling on findings count (not a review-quality cap). */
export const MAX_REVIEW_PAYLOAD_FINDINGS = 128;
/** Max findings accepted from one specialist report. */
export const MAX_SPECIALIST_FINDINGS = 20;
/** Max inline review threads attempted in one GitHub review submission. */
export const MAX_INLINE_REVIEW_COMMENTS = 50;
/** Max incremental COMMENT review calls accepted during one orchestrated review run. */
export const MAX_THREAD_PUBLISH_CALLS = 8;

export const REVIEW_SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const;

export const VALIDATION_REPAIR_ROUNDS = 3;
export const PUBLISH_RECOVERY_ROUNDS = 4;

export const PUBLISH_BUDGET_EXHAUSTED_MESSAGE =
  "Review publish budget exhausted for this run. Do not call submitReview again.";

/** Review harness: step enforcement when diff cache is empty at submitReview. */
export const REVIEW_DIFF_CACHE_REQUIRED_MESSAGE =
  "Call listChangedFiles and getWorkspaceDiff first; diff index is empty so inline anchors cannot be validated.";

/** Review harness: anchor menu block header (untrusted user content). */
export const REVIEW_ANCHOR_MENU_BLOCK_LABEL = "anchor_menu";

/** ReviewPayload validation failure kinds for harness metrics and repair prompts. */
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
export const ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS = 4;
export const MAX_REVIEW_PUBLISH_CALLS = 2;
export const REVIEW_MIN_CONFIDENCE = 1;
/** Must not exceed GITHUB_PULL_REQUEST_FILES_API_MAX_FILES (GitHub pull request files API cap). */
export const MAX_PR_FILES_LISTED = 300;
export const MAX_PR_FILES_PATCH_BYTES = 500_000;
export const REVIEW_CI_SUMMARY_WAIT_MS = 15_000;
export const REVIEW_ANCHOR_MENU_MAX_FILES = 40;
export const REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE = 20;
