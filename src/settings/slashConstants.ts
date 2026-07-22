/** Slash command help (scheduler ack replies). */
export const SLASH_HELP_BODY = [
  "### PR Agent help",
  "",
  "Commands (first line of a **new** comment):",
  "- `/help` — show this message",
  "- `/ask <question>` — ask about this PR or a specific line of code (or `@`-mention the bot anywhere on the PR for the same conversational Q&A)",
  "- `/describe` — generate or refresh the PR title/body summary (also runs automatically on PR open)",
  "- `/review` — general bug-and-correctness review (also runs automatically on PR open; further reviews need a manual `/review`)",
  "- `/triage` — fix earlier PR Agent findings on this PR: commits and pushes minimal fixes to the PR branch, resolves fixed threads (trigger-only; same-repo PRs). Post on the PR conversation to triage all findings, or reply `/triage` inside a bot inline finding thread to triage that finding only.",
  "",
  "Notes:",
  "- Automated runs follow the `FEATURE_*` settings (docs/features.md): review and describe fire when a PR opens in `auto` mode, so follow-up pushes need a manual `/review`.",
  "- `/describe` merges generated content below the PR Agent description header; your text above that header is preserved.",
  "- `/ask` and `@bot` mentions load the containing comment thread so follow-ups stay in conversation; they do not change finding severity or dismiss threads.",
  "- Edited comments are ignored for slash parsing in v1.",
].join("\n");

export function slashDisabledBody(command: string): string {
  return `\`/${command}\` is disabled on this deployment (\`FEATURE_*\` settings — see docs/features.md).`;
}
