/** Slash command help (scheduler ack replies). */
export const SLASH_HELP_BODY = [
  "### PR Agent help",
  "",
  "Commands (first line of a **new** comment):",
  "- `/help` - show this message",
  "- `/ask <question>` - ask about this PR or a specific line (or `@`-mention the bot for the same Q&A)",
  "- `/describe` - refresh the PR title and body summary (also runs when a PR opens)",
  "- `/review` - review the PR for bugs (also runs when a PR opens; later reviews need `/review`)",
  "- `/triage` - fix earlier PR Agent findings on this PR. Post on the conversation for all findings, or reply `/triage` inside one finding thread for that finding only.",
  "",
  "Notes:",
  "- What runs automatically depends on the `FEATURE_*` settings (see docs/features.md). Review and describe fire on PR open in `auto` mode; later pushes need a manual `/review`.",
  "- `/describe` writes below the PR Agent description header and keeps your text above it.",
  "- `/ask` and `@bot` mentions read the containing thread so follow-ups stay in conversation. They do not change finding severity or dismiss threads.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export function slashDisabledBody(command: string): string {
  return `\`/${command}\` is disabled on this deployment (\`FEATURE_*\` settings; see docs/features.md).`;
}
