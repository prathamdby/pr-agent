import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentRunnerUsageMetadata } from "../../providers/usageMetadata.ts";
import type { AgentRunnerToolExecutor } from "../../providers/interface.ts";
import type { AgentLifecycleEvent, AgentSessionRole, PiSessionSendOptions } from "../types.ts";

export type EvidenceReadAttempt = {
  readonly kind: "lines" | "diff" | "block";
  readonly path: string;
  readonly headSha: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly number[];
  readonly clampedLines: readonly number[];
  readonly contentHash: string;
  readonly content: string;
  readonly tool: string;
};

export type BoundEvidenceMemo = {
  readonly assistantIndex: number;
  readonly visible: readonly {
    readonly path: string;
    readonly headSha: string;
    readonly tool: string;
    readonly contentHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly lines: readonly number[];
    readonly content: string;
  }[];
};

export type SessionSendState = {
  readonly opts: PiSessionSendOptions;
  rounds: number;
  readonly countedCalls: Set<string>;
  budgetBlockedCalls: number;
  stopped: boolean;
  reservedFired: boolean;
  lastActivityAt: number;
  assistantIndex: number;
};

export type SessionTraceLike = {
  beginSend: (send: PiSessionSendOptions) => void;
  event: (event: import("../sessionTrace.ts").SessionTraceEvent) => void;
  endSend: (end: string, errorCode?: string, errorDetail?: string) => void;
  dispose: () => void;
};

export type DurableSessionState = {
  trace?: SessionTraceLike;
  readonly role: AgentSessionRole;
  readonly headSha?: string;
  readonly provider: string;
  readonly model: string;
  readonly systemPromptSharedHead?: string;
  readonly systemPrompt: string;
  readonly toolDefinitions: unknown;
  promptCacheTracker?: (history: unknown) => void;
  readonly eventSink: (event: AgentLifecycleEvent) => void;
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly hostSignal?: AbortSignal;
  readonly phaseAllowedTools?: (phase: string, toolName: string) => string | undefined;
  currentSend?: SessionSendState;
  sendSeq: number;
  aborted: boolean;
  usage?: AgentRunnerUsageMetadata;
  effort?: string;
  evidence: {
    readonly attempts: Map<string, EvidenceReadAttempt>;
    requestVisible: Map<string, BoundEvidenceMemo["visible"]>;
    bindings: BoundEvidenceMemo[];
    readonly reconLines: readonly {
      readonly path: string;
      readonly contentHash: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly lines: readonly number[];
      readonly content: string;
    }[];
    readonly spillRoots: Set<string>;
    spillBytes: number;
    spillExpired: boolean;
  };
};

const sessionStates = new Map<ConversationId, DurableSessionState>();

export function registerSessionState(conversationId: ConversationId, state: DurableSessionState) {
  sessionStates.set(conversationId, state);
}

export function sessionStateFor(conversationId: ConversationId) {
  return ((pinnedReturn: DurableSessionState | undefined) => pinnedReturn)(
    sessionStates.get(conversationId),
  );
}

export function dropSessionState(conversationId: ConversationId) {
  sessionStates.delete(conversationId);
}

export function resetSendUsage(state: DurableSessionState) {
  state.usage = undefined;
  state.effort = undefined;
}

export function contextForToolCall(
  state: DurableSessionState,
  api: { readonly callId: string; readonly conversationId: ConversationId },
  signal: AbortSignal,
) {
  return {
    signal,
    toolCallId: api.callId,
    conversationId: api.conversationId,
    emit: (event: AgentLifecycleEvent) => state.eventSink(event),
    role: state.role,
    provider: state.provider,
    model: state.model,
  };
}
