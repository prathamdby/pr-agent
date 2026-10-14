export const descriptionNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Installed: `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace` (literal match), `findFiles` (fuzzy path match), `getWorkspaceDiff`, `getWorkspaceBlame`, `resolveSymbol`, `submitDescription`.",
  "`listChangedFiles` gives the paths; diffs show what changed and cost less than whole files; focused reads supply context. Blame is for when authorship decides the description. `findFiles` and `resolveSymbol` matches are hints until `readWorkspaceFile` confirms them.",
  "No tool reads the PR conversation, issues, or external URLs.",
].join("\n");
