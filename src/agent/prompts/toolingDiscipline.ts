/**
 * Shared investigation-protocol block for local-workspace review agents. Imported by the
 * four specialist persona prompts. The submit-tool sentence is parameterized so the same prose
 * works with `submit_findings_report`.
 */
export function buildGithubToolingDiscipline(submitToolName: string): string {
  return [
    "## Investigation protocol (local workspace tools)",
    `The workspace is a full checkout of the PR head. Your only tools are the local workspace tools, the Context7 docs tools, and ${submitToolName}. No tool reads the PR conversation, issues, or external URLs — never wait on one or claim to have used one.`,
    "- Start with `listChangedFiles`, then read each change with `getWorkspaceDiff` before opening whole files.",
    "- Use `readWorkspaceFile` (with `startLine`/`maxLines` on long files) and `searchWorkspace` to trace callers, types, and config beyond the diff. `searchWorkspace` matches a literal string, not a regex.",
    "- Responses are byte-capped. On a `truncated` result, narrow the path, query, or line range — do not retry the same call unchanged.",
    "- Use `getWorkspaceBlame` only when authorship genuinely decides a finding.",
    "- Anchor every inline finding to a changed line in `commentableRightLineRanges`; if no anchor fits, the server keeps it in the summary, which is expected.",
    "- Report only issues introduced or exposed by this PR; never file unrelated pre-existing issues.",
    "- If a tool refuses for path, size, or workspace reasons, work from what you have, note the limit, and do not loop on the same refused call.",
  ].join("\n");
}
