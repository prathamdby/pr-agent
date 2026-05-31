/** Agent work (pg-boss) queue names. */
export const ACK_QUEUE = "agent-work-ack";
export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const DESCRIPTION_QUEUE = "agent-work-description";
export const ACK_DEAD_LETTER_QUEUE = "agent-work-ack-dead";
export const REVIEW_DEAD_LETTER_QUEUE = "agent-work-review-dead";
export const ASK_DEAD_LETTER_QUEUE = "agent-work-ask-dead";
export const DESCRIPTION_DEAD_LETTER_QUEUE = "agent-work-description-dead";
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
/** PR description auto-runs only on first open; use `/describe` after that. */
export const AUTOMATED_DESCRIPTION_PR_ACTIONS = new Set(["opened"]);
export const AUTOMATED_REVIEW_LENS = "review" as const;
export const DESCRIPTION_PUBLISH_LENS = "description" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;

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

/** Review output sentinels and labels. */
export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const SECURITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Security Review";
export const QUALITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Quality Review";
export const LABEL_REVIEW_EFFORT_PREFIX = "Review effort ";
export const LABEL_SECURITY_CONCERN = "Possible security concern";

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const SECURITY_REVIEW_POINTER_BODY =
  "See the security review summary in the PR conversation.";
export const QUALITY_REVIEW_POINTER_BODY =
  "See the code-quality review summary in the PR conversation.";
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
];

export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.env\.[^/]+$/i,
  /\.pem$/i,
  /(^|\/)id_rsa(?:\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)secrets?\./i,
  /(^|\/)\.netrc$/i,
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
export const DEFAULT_COOLDOWN_SECONDS = 60;
export const MESSAGE_TRUNCATE = 500;
export const SECONDARY_RATE_MESSAGE = /\bsecondary rate\b/i;
export const BAD_CREDENTIALS_MESSAGE = /bad credentials/i;
export const INSTALLATION_TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000;
export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 3;
export const COMMENTS_PAGE_SIZE = 100;
export const COMMENT_PAGINATION_MAX_PAGES = 20;

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
  "",
  "Notes:",
  "- Automated `/describe` runs on PR `opened` only; `/review` runs on `opened` / `synchronize` / `reopened`.",
  "- `/describe` merges generated content below the PR Agent description header; your text above that header is preserved.",
  "- `/review`, `/review-security`, and `/review-quality` can each leave summary comments on the same PR (different sentinels).",
  "- `/ask` answers one question at a time; it does not remember prior `/ask` commands.",
  "- Some security issues may appear in both passes; pick the command that matches your question.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

/** Database migrations path (relative to process cwd). */
export const MIGRATIONS_DIR_NAME = "migrations";
