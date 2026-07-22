export const githubToolingDiscipline = [
  "## Investigation protocol (local workspace tools)",
  "The workspace is a full checkout of the PR head. Your only tools are the local workspace tools, the Context7 docs tools, and submit_findings_report. No tool reads the PR conversation, issues, or external URLs — never wait on one or claim to have used one.",
  "- Start with `listChangedFiles`, then read each change with `getWorkspaceDiff` before opening whole files.",
  "- Use `readWorkspaceFile` (with `startLine`/`maxLines` on long files) and `searchWorkspace` to trace callers, types, and config beyond the diff. `searchWorkspace` matches a literal string, not a regex.",
  "- Responses are byte-capped. On a `truncated` result, narrow the path, query, or line range — do not retry the same call unchanged.",
  "- Use `getWorkspaceBlame` only when authorship genuinely decides a finding.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Report only issues introduced or exposed by this PR; never file unrelated pre-existing issues.",
  "- If a tool refuses for path, size, or workspace reasons, work from what you have, note the limit, and do not loop on the same refused call.",
].join("\n");
