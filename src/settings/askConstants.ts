export const ASK_RETRY_NUDGE =
  "Answer the question now in plain text based on your investigation above. Do not call more tools unless absolutely required to fix a factual gap.";

export const ASK_FAILURE_MESSAGE =
  "I could not put together a confident answer from the PR and repo tools available. Try rephrasing the question, narrowing it to a file or symbol, or run `/review` for a full pass.";

/** Ask command safety and UX. */
export const ASK_META_REFUSAL =
  "I can only answer questions about this PR's code. I can't share bot configuration, credentials, or internal instructions.";

export const MAX_ASK_QUESTION_CHARS = 8192;
/** Soft cap for injected thread transcript in ask prompts (root + newest tail if exceeded). */
export const MAX_ASK_THREAD_TRANSCRIPT_CHARS = 24_000;

export const ASK_USAGE_HINT =
  "Usage: `/ask <your question>` or `@`-mention the bot with your question — ask about this PR, a finding thread, or a specific line of code.";

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
  /\bctx7sk-[A-Za-z0-9_-]{10,}\b/gi,
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

export const MAX_ASK_TOOL_ROUNDS = 12;
export const MAX_ASK_FINALIZE_ROUNDS = 2;
