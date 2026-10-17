export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const LABEL_REVIEW_SIZE_PREFIX = "size:";
export const LABEL_SECURITY_CONCERN = "Possible security concern";
export const LABEL_CATEGORY_PREFIX = "Category: ";

export const REVIEW_CANCEL_POLL_INTERVAL_MS = 2_000;

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const AGENT_FIX_PROMPT_PREAMBLE =
  "Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, and keep changes minimal.";
export const AGENT_FIX_PROMPT_ACCORDION_SUMMARY = "Fix all findings (agent prompt)";

export const REVIEW_OVERVIEW_ALERT = "NOTE";
export const REVIEW_FAILURE_ALERT = "CAUTION";
export const REVIEW_PROGRESS_NOTE = "Review in progress on the latest commit.";
export const REVIEW_PROGRESS_QUEUED_NOTE = "Review queued on the latest commit.";
export const REVIEW_AWAITING_APPROVAL_NOTE =
  "Review waiting for maintainer approval. A maintainer can approve the workflow runs, approve this pull request, or comment `/review`.";
export const REVIEW_PROGRESS_QUEUE_LABEL = "Queue";

export function sanitizeGithubLogin(login: string): string {
  const trimmed = login.trim().replace(/^@+/, "");
  if (trimmed.length > 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(trimmed)) {
    return trimmed;
  }
  return "user";
}

export type ReviewCancelAttribution =
  | { readonly kind: "user"; readonly login: string }
  | { readonly kind: "merged" }
  | { readonly kind: "closed" };

export function reviewCancelAttributionForClosedPr(merged: boolean): ReviewCancelAttribution {
  return merged ? { kind: "merged" } : { kind: "closed" };
}

export function reviewProgressCancelledNote(attribution: ReviewCancelAttribution): string {
  switch (attribution.kind) {
    case "merged":
      return "PR merged.";
    case "closed":
      return "PR closed.";
    case "user":
      return `Cancelled by @${sanitizeGithubLogin(attribution.login)}. Run \`/review\` to try again.`;
    default: {
      const exhaustive: never = attribution;
      return exhaustive;
    }
  }
}

export function reviewCancelLastError(attribution: ReviewCancelAttribution): string {
  switch (attribution.kind) {
    case "merged":
      return "Pull request merged";
    case "closed":
      return "Pull request closed";
    case "user":
      return "Cancelled by slash /cancel";
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
export const REVIEW_PROGRESS_SOURCE_AUTO = "Pull request update";
export const REVIEW_PROGRESS_SOURCE_SLASH = "Slash command";

export const LIGHTWEIGHT_REVIEW_COMPLETION_LEAD =
  "No deep review run: this automated review was skipped because the change set is documentation-only.";
export const LIGHTWEIGHT_REVIEW_COMPLETION_REASON = "Documentation-only change set";
export const LIGHTWEIGHT_REVIEW_COMPLETION_HINT = "Use /review for a full review.";

export const REVIEW_SIZE_TIER_SMALL_MAX_FILES = 10;
export const REVIEW_SIZE_TIER_MEDIUM_MAX_FILES = 50;
export const REVIEW_SIZE_TIER_LARGE_MIN_CHANGES = 2000;

export const REPO_POLICY_DIRNAME = ".pr-agent";
export const REPO_POLICY_EXTENSION = ".mdc";
export const MAX_REPO_POLICY_BYTES = 32 * 1024;
export const MAX_REPO_POLICY_FILE_BYTES = 8 * 1024;
export const MAX_REPO_POLICY_FILES = 20;
export const MAX_REPO_POLICY_PATH_PATTERN_CHARS = 200;
export const MAX_REPO_POLICY_INSTRUCTION_CHARS = 1000;

export const AGENT_INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
export const MAX_AGENT_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_AGENT_INSTRUCTION_FILE_BYTES = 32 * 1024;

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

export const REVIEW_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;

export const REVIEW_FINDING_TITLE_MAX_CHARS = 80;
export const REVIEW_FINDING_DETAIL_MAX_CHARS = 4000;
export const REVIEW_FINDING_FIX_PROMPT_MAX_CHARS = 2000;
export const REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS = 2000;
export const REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const MAX_PRIOR_INLINE_FEEDBACK_THREADS = 20;
export const MAX_PRIOR_INLINE_REPLY_CHARS = 500;
export const REVIEW_FOLLOW_UP_MAX_CHARS = 2000;
export const REVIEW_GATE_PROSE_MAX_CHARS = 280;
export const REVIEW_GATE_PROSE_UNASSESSED = "Not assessed.";

export const REVIEW_SUMMARY_BODY_MAX_CHARS = 60_000;
export const REVIEW_SUMMARY_COMPACTION_NOTE =
  "Some finding details were shortened to fit GitHub comment size limits. See inline threads where posted.";
export const REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX =
  "finding(s) omitted from this summary due to GitHub comment size limits — see inline threads where posted.";
export const REVIEW_CHECK_RUN_RESERVATION_STALE_MS = 5 * 60 * 1000;
export const REVIEW_CHECK_RUN_WAIT_FOR_ID_MS = 15_000;
export const REVIEW_CHECK_RUN_WAIT_POLL_MS = 100;

export const OWN_COMMIT_STATUS_CONTEXT = "pr-agent/review";

export const CI_STATE_MAX_CHECKS = 200;

export const REVIEW_CI_SUMMARY_MAX_FAILURES = 3;
export const REVIEW_CI_SUMMARY_LOG_MAX_BYTES = 24_000;
export const REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS = 12_000;
export const REVIEW_CI_SUMMARY_LOG_MAX_JOBS = 3;
export const REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE = 4;
export const REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS = 240;
export const REVIEW_CI_SUMMARY_REASON_MAX_CHARS = 400;
export const REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS = 280;

export const REVIEW_CI_SUMMARY_GRANT_CHECKS =
  "PR Agent can't see check runs on this head. In the GitHub App settings, set Checks to Read, then run /review again.";

export const REVIEW_CI_SUMMARY_GRANT_ACTIONS =
  "CI failed, but PR Agent can't download the job logs. Set Actions to Read on the GitHub App so the next summary can explain what broke.";

export const REVIEW_CI_SUMMARY_UNAVAILABLE = "CI status unavailable";

export const REVIEW_CI_SUMMARY_INCOMPLETE =
  "CI results are incomplete; additional checks were not retrieved.";
export const MAX_REVIEW_PAYLOAD_FINDINGS = 128;
export const MAX_SPECIALIST_FINDINGS = 20;
export const MAX_INLINE_REVIEW_COMMENTS = 50;
export const MAX_THREAD_PUBLISH_CALLS = 8;

export const REVIEW_SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const;

export const VALIDATION_REPAIR_ROUNDS = 3;
export const PUBLISH_RECOVERY_ROUNDS = 2;

export type ReviewValidationFailureKind =
  | "missing_field"
  | "wrong_type"
  | "enum_mismatch"
  | "string_too_short"
  | "array_too_long"
  | "out_of_range"
  | "custom_predicate"
  | "other";

export type ReviewPhase =
  | "investigation"
  | "pre_submit"
  | "validation_repair"
  | "publish_recovery"
  | "plaintext_fallback";

export const MAX_TOOL_ROUNDS = 2_000;
export const ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS = 4;
export const MAX_PR_FILES_LISTED = 300;
export const MAX_PR_FILES_PATCH_BYTES = 500_000;
export const REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE = 20;
