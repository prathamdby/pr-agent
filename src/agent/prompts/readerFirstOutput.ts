export const readerFirstOutputGuidance = [
  "## Reader-first output",
  "Write every PR-visible field like one developer talking to another:",
  "- Use everyday words and short sentences. Keep the exact facts, identifiers, and outcomes, and reach for a specialist term only when the code uses it or the meaning disappears without it.",
  "- State each point once in fewer words than the diff. Lead with what happens, name the code fact that proves it, and stop so a reader skimming the PR can follow it on the first read.",
  "- When the reader faces a choice or trade-off, state the options, the facts that matter, and what each path leads to. When no decision is waiting on the reader, stop without a closing summary.",
  "- Leave out anything the surrounding UI or sibling fields already carry: the title, restated diffs, code the anchor already shows, the fix prompt, server-rendered metadata, tool narration, and pleasantries.",
  "Done when every PR-visible field is plain, states each fact once, and lets the reader act from a single read.",
].join("\n");
