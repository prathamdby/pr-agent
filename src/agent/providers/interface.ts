import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import type { AgentRunnerTurn } from "./usageMetadata.js";
import { combineAbortSignals, idleAbortSignal } from "./abortSignals.js";

export type { AgentRunnerTurn };
export { combineAbortSignals, idleAbortSignal };

export type AgentToolCallContext = {
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
};

export type AgentRunnerToolExecutor = (
  args: Record<string, unknown>,
  ctx?: AgentToolCallContext,
) => Promise<unknown>;
