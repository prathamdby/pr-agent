/** Agent work (pg-boss) queue names. */
export const ACK_QUEUE = "agent-work-ack";
export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const ACK_DEAD_LETTER_QUEUE = "agent-work-ack-dead";
export const REVIEW_DEAD_LETTER_QUEUE = "agent-work-review-dead";
export const ASK_DEAD_LETTER_QUEUE = "agent-work-ask-dead";
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
export const AUTOMATED_REVIEW_LENS = "review" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;

/** Review output sentinels and labels. */
export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const SECURITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Security Review";
export const LABEL_REVIEW_EFFORT_PREFIX = "Review effort ";
export const LABEL_SECURITY_CONCERN = "Possible security concern";

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const SECURITY_REVIEW_POINTER_BODY =
  "See the security review summary in the PR conversation.";
export const REPEAT_NO_BUGS_PREFIX = "No bugs found";
export const AGENT_FIX_PROMPT_PREAMBLE =
  "Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.";
export const AGENT_FIX_PROMPT_ACCORDION_SUMMARY = "Fix all findings (agent prompt)";
export const REVIEW_POINTER_BODY_MAX_CHARS = 60_000;
export const AGENT_FIX_PROMPT_TRUNCATION_SUFFIX =
  "\n...[truncated; see inline threads and PR summary]";

/** Review comment formatting (GitHub markdown). */
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

export const MAX_REVIEW_FOLLOW_UPS = 5;
export const REVIEW_EFFORT_MIN = 1;
export const REVIEW_EFFORT_MAX = 5;

export const REVIEW_SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const;

/** Review / ask agent loops. */
export const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;

export const REVIEW_CIRCUIT_OPEN_USER_MESSAGE =
  "Stop GitHub tool calls; call submitReview now with your current analysis from the conversation above.";
export const REVIEW_CIRCUIT_OPEN_TOOL_RESULT =
  "Rate-limit circuit open: further GitHub investigation tools are blocked for this review run. Call submitReview now.";

export const ASK_CIRCUIT_OPEN_USER_MESSAGE =
  "Stop GitHub tool calls; answer the question now using what you already found in this conversation.";
export const ASK_CIRCUIT_OPEN_TOOL_RESULT =
  "Rate-limit circuit open: further GitHub investigation tools are blocked for this ask run. Answer the question with your current analysis.";

export const PROSE_ONLY_NUDGE =
  "You replied with text only. Call submitReview now with a complete ReviewPayload (required).";

export const PUBLISH_RECOVERY_ROUNDS = 4;
export const PUBLISH_RECOVERY_PROMPTS = [
  "You ended with a text reply but never called submitReview. Call submitReview exactly once now with a complete ReviewPayload based on your analysis above. Do not continue investigating unless required to fix payload validation.",
  "The structured review was still not published. You must call submitReview now with a valid ReviewPayload. No prose-only replies.",
  "Final publish attempt: call submitReview immediately with your ReviewPayload. This is required to complete the review.",
] as const;

export const VALIDATION_REPAIR_ROUNDS = 3;

export const ASK_RETRY_ROUNDS = 4;
export const ASK_RETRY_NUDGE =
  "Answer the question now in plain text based on your investigation above. Do not call more tools unless absolutely required to fix a factual gap.";

export const ASK_FAILURE_MESSAGE =
  "I could not put together a confident answer from the PR and repo tools available. Try rephrasing the question, narrowing it to a file or symbol, or run `/review` for a full pass.";

export const PUBLISH_BUDGET_EXHAUSTED_MESSAGE =
  "Review publish budget exhausted for this run. Do not call submitReview again.";

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
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bpostgres(?:ql)?:\/\/\S+/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
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
export const COMMENTS_PAGE_SIZE = 100;

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

/** Public-output sanitizer. */
export const PUBLIC_OUTPUT_BANNED_PATTERNS: RegExp[] = [
  /\bsystem prompt\b/i,
  /\btooling budget\b/i,
  /\bserver logs\b/i,
  /Line could not be resolved/i,
  /\bsubmitReview\b/i,
  /\bstructured publish\b/i,
  /\bmanual review\b/i,
  /\bGitHub API\b/i,
  /\bDATABASE_URL\b/,
  /\bOPENAI_API_KEY\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d+\/\d+ attempt\(s\)\b/i,
  /\bBEGIN_SHARED_METHODOLOGY\b/,
  /\bSingle-pass review contract\b/i,
];

export const PUBLIC_OUTPUT_REDACTION = "[redacted internal details]";

/** Logging. */
export const MAX_LOG_MESSAGE_LEN = 2_000;

/** Slash command help (scheduler ack replies). */
export const SLASH_HELP_BODY = [
  "### PR Agent help",
  "",
  "Commands (first line of a **new** comment):",
  "- `/help` — show this message",
  "- `/ask <question>` — ask about this PR or a specific line of code",
  "- `/review` — general bug-and-correctness review (also runs automatically on PR open/sync)",
  "- `/review-security` — deep security review (DeepSec-style; trigger-only, not auto-run)",
  "",
  "Notes:",
  "- Automated reviews use `/review`'s lens on PR `opened` / `synchronize` / `reopened`.",
  "- `/review` and `/review-security` can both leave summary comments on the same PR (different sentinels).",
  "- `/ask` answers one question at a time; it does not remember prior `/ask` commands.",
  "- Some security issues may appear in both passes; pick the command that matches your question.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

/** Database migrations path (relative to process cwd). */
export const MIGRATIONS_DIR_NAME = "migrations";
