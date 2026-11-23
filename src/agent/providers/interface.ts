import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.ts";
import type { AgentSessionRole } from "../runtime/types.ts";
import type { AgentRunnerTurn, TurnEnd } from "./usageMetadata.ts";

export type { AgentRunnerTurn, TurnEnd };
export function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>) {
  const defined = signals.filter((signal): signal is AbortSignal => signal != null);
  if (defined.length === 0)
    return ((pinnedReturn: AbortSignal) => pinnedReturn)(new AbortController().signal);
  if (defined.length === 1) return ((pinnedReturn: AbortSignal) => pinnedReturn)(defined[0]);
  return ((pinnedReturn: AbortSignal) => pinnedReturn)(AbortSignal.any(defined));
}

export type HostCallOutcome =
  | { readonly status: "completed"; readonly output: unknown; readonly outputBytes: number }
  | { readonly status: "error"; readonly errorKind: string };

export type HostCallTracer = (
  tool: string,
  input: unknown,
) => ((outcome: HostCallOutcome) => void) | undefined;

export type AgentToolCallContext = {
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  readonly conversationId?: number;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly traceHostCall?: HostCallTracer;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
};

export type AgentRunnerToolExecutor = (
  args: Record<string, unknown>,
  ctx?: AgentToolCallContext,
) => Promise<unknown>;
