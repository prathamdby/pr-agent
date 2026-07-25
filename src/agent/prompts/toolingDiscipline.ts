export const githubToolingDiscipline = [
  "## Investigation protocol (local workspace tools)",
  "Follow each local workspace tool's description for investigation order, literal search, truncation, and blame. The workspace is a full checkout of the PR head. Your only tools are the local workspace tools, the Context7 docs tools, and submit_findings_report — no tool reads the PR conversation, issues, or external URLs.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Report only issues introduced or exposed by this PR; never file unrelated pre-existing issues.",
  "- If a tool refuses for path, size, or workspace reasons, work from what you have, note the limit, and do not loop on the same refused call.",
].join("\n");
