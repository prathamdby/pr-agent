import type { AuthoritativeStructuredState } from "./types.js";

export const SERVER_COMPACTION_INSTRUCTIONS = [
  "Compact the conversation to free context.",
  "Preserve the task goal, remaining work, and tool discipline.",
  "Do not invent specialist reports, findings, publish outcomes, or checkpoint state.",
  "Treat any prior summary as advisory; server-owned structured state will be re-injected after compaction.",
].join(" ");

/** JSON block re-injected after compaction; authoritative over model-authored summaries. */
export function structuredStateReinjectionPrompt(state: AuthoritativeStructuredState): string {
  return [
    "Authoritative structured state (server-owned; overrides any compaction summary):",
    "```json",
    JSON.stringify(
      {
        version: state.version,
        payload: state.payload,
      },
      null,
      2,
    ),
    "```",
    "Continue from this state. Do not replace specialist reports, accepted findings, publish ledger entries, or checkpoints with compacted prose.",
  ].join("\n");
}

export function canCompactAtBoundary(params: {
  readonly turnSettled: boolean;
  readonly pendingExternalMutation: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!params.turnSettled) {
    return { ok: false, reason: "turn_not_settled" };
  }
  if (params.pendingExternalMutation) {
    return { ok: false, reason: "pending_external_mutation" };
  }
  return { ok: true };
}
