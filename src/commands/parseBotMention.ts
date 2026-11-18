export function botMentionLogins(botLogin: string) {
  const trimmed = botLogin.trim();
  if (!trimmed) return ((pinnedReturn: readonly string[]) => pinnedReturn)([]);
  const logins = [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("[bot]")) {
    const slug = trimmed.slice(0, -"[bot]".length);
    if (slug.length > 0) logins.push(slug);
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)(logins);
}

function mentionPattern(botLogin: string) {
  const alternation = botMentionLogins(botLogin)
    .map((login) => login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return ((pinnedReturn: RegExp) => pinnedReturn)(
    new RegExp(`(^|[^A-Za-z0-9_-])@(${alternation})(?![A-Za-z0-9_-])`, "gi"),
  );
}

export function commentMentionsBot(body: string, botLogin: string) {
  if (!botLogin.trim()) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(mentionPattern(botLogin).test(body));
}

export function stripBotMentions(body: string, botLogin: string) {
  if (!botLogin.trim()) return ((pinnedReturn: string) => pinnedReturn)(body);
  return ((pinnedReturn: string) => pinnedReturn)(
    body
      .replace(mentionPattern(botLogin), "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}
