/**
 * Detect and strip @-mentions of the GitHub App bot login in comment bodies.
 * Logins look like `pr-agent[bot]`; also accept the slug without the `[bot]` suffix.
 */

/** Login forms that count as tagging this bot (full login + optional slug without `[bot]`). */
export function botMentionLogins(botLogin: string): readonly string[] {
  const trimmed = botLogin.trim();
  if (!trimmed) return [];
  const logins = [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("[bot]")) {
    const slug = trimmed.slice(0, -"[bot]".length);
    if (slug.length > 0) logins.push(slug);
  }
  return logins;
}

function mentionPattern(botLogin: string): RegExp {
  const alternation = botMentionLogins(botLogin)
    .map((login) => login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Word-ish boundary: avoid matching `@pr-agent-extra` when login is `pr-agent`.
  return new RegExp(`(^|[^A-Za-z0-9_-])@(${alternation})(?![A-Za-z0-9_-])`, "gi");
}

export function commentMentionsBot(body: string, botLogin: string): boolean {
  if (!botLogin.trim()) return false;
  return mentionPattern(botLogin).test(body);
}

/** Remove bot @-mentions; collapse leftover whitespace. */
export function stripBotMentions(body: string, botLogin: string): string {
  if (!botLogin.trim()) return body;
  return body
    .replace(mentionPattern(botLogin), "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
