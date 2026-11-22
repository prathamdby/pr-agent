import { defineSignal } from "@earendil-works/pi-durable";
import type { ConversationId, SignalKey, TaskId } from "@earendil-works/pi-durable";
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

export type VisibleRead = {
  readonly path: string;
  readonly headSha: string;
  readonly tool: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
};

export function includesEvidenceRead(
  reads: readonly EvidenceReadAttempt[],
  read: EvidenceReadAttempt,
) {
  return reads.some(
    (r) =>
      r.kind === read.kind &&
      r.path === read.path &&
      r.startLine === read.startLine &&
      r.endLine === read.endLine &&
      r.contentHash === read.contentHash,
  );
}

export function visibleReadKey(read: VisibleRead) {
  return JSON.stringify([
    read.path,
    read.startLine,
    read.endLine,
    read.contentHash,
    read.headSha,
    read.tool,
  ]);
}

export type SessionSendState = {
  readonly opts: PiSessionSendOptions;
  readonly countedCalls: Set<number>;
  readonly blockedCalls: Set<number>;
  stopped: boolean;
  reservedFired: boolean;
  lastActivityAt: number;
  assistantIndex: number;
};

export const WarmupReleased = defineSignal({
  name: "pr.warmup-released",
  version: 1,
  schema: { type: "object", additionalProperties: true },
});

export type WarmupReleaseTarget = {
  readonly taskId: TaskId;
  readonly key: string;
  sent: boolean;
};

export function warmupReleaseKey(turnNo: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`lead:${turnNo}`);
}

export function warmupReleaseSignalKey(turnNo: number) {
  return ((pinnedReturn: SignalKey<unknown>) => pinnedReturn)(
    WarmupReleased.key(warmupReleaseKey(turnNo)),
  );
}

export function beginSend(opts: PiSessionSendOptions) {
  return {
    opts,
    countedCalls: new Set<number>(),
    blockedCalls: new Set<number>(),
    stopped: false,
    reservedFired: false,
    lastActivityAt: Date.now(),
    assistantIndex: 0,
  };
}

export function maxTurnsForSend(opts: PiSessionSendOptions) {
  return opts.maxToolRounds === undefined
    ? null
    : opts.maxToolRounds + 2 + Number(opts.reservedTerminalTool !== undefined);
}

export type SessionTraceLike = {
  beginSend: (send: PiSessionSendOptions) => void;
  event: (event: import("../sessionTrace.ts").SessionTraceEvent) => void;
  endSend: (end: string, errorCode?: string, errorDetail?: string) => void;
  dispose: () => void;
};

export type DurableSessionState = {
  journal?: {
    charge(taskId: number, blocked: boolean): Promise<void>;
    read(callId: string, read: EvidenceReadAttempt): Promise<void>;
    credit(reads: readonly VisibleRead[]): Promise<void>;
    pending(reads: readonly VisibleRead[]): Promise<void>;
  };
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
  warmupRelease?: WarmupReleaseTarget;
  currentSend?: SessionSendState;
  sendSeq: number;
  aborted: boolean;
  usage?: AgentRunnerUsageMetadata;
  effort?: string;
  evidence: {
    readonly attempts: Map<string, readonly EvidenceReadAttempt[]>;
    visible: readonly VisibleRead[];
    bound: readonly VisibleRead[];
    readonly credited: Set<string>;
    readonly reconLines: readonly {
      readonly clampedLines: readonly number[];
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
