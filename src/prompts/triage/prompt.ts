export const triageNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Inspect with `readWorkspaceFile`, `searchWorkspace` (literal match, not regex), and `getWorkspaceDiff`.",
  "Change files with `editWorkspaceFile` or `createWorkspaceFile`, commit each fix with `commitFix`, and record the result with `submitTriage`. These are the only write paths; edits outside the files the inventory names are refused.",
].join("\n");
