import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerToolExecutor, AgentRunnerTurn } from "../providers/interface.js";
import { promptMetadataFromText } from "../providers/usageMetadata.js";
import { canCompactAtBoundary, structuredStateReinjectionPrompt } from "./compactionPolicy.js";
import type {
  AgentLifecycleEvent,
  ModelAssignment,
  PiSession,
  PiSessionCreateParams,
  PiSessionSendOptions,
} from "./types.js";

export type FakePiSessionScript = (ctx: {
  readonly prompt: string;
  readonly opts: PiSessionSendOptions;
  readonly emit: (event: AgentLifecycleEvent) => void;
}) => Promise<string> | string;

export type FakePiSessionControls = {
  readonly events: AgentLifecycleEvent[];
  readonly sends: Array<{ prompt: string; opts: PiSessionSendOptions }>;
  readonly setScript: (script: FakePiSessionScript) => void;
  readonly markCompactionBoundary: () => void;
  readonly setPendingExternalMutation: (pending: boolean) => void;
  readonly pendingExternalMutation: () => boolean;
  readonly compactionCount: () => number;
};

export function createFakePiSession(
  params: PiSessionCreateParams,
  initialScript?: FakePiSessionScript,
): { readonly session: PiSession; readonly controls: FakePiSessionControls } {
  const events: AgentLifecycleEvent[] = [];
  const sends: Array<{ prompt: string; opts: PiSessionSendOptions }> = [];
  let script: FakePiSessionScript =
    initialScript ??
    (async () => {
      return "";
    });
  let structuredState = params.structuredState;
  let aborted = false;
  let disposed = false;
  let activeToolNames = params.tools.map((tool) => tool.name);
  const allToolNames = [...activeToolNames];
  let pendingExternalMutation = false;
  let compactionCount = 0;
  let activeModel: ModelAssignment = params.primary;

  const emit = (event: AgentLifecycleEvent) => {
    events.push(event);
    params.eventSink(event);
  };

  const controls: FakePiSessionControls = {
    events,
    sends,
    setScript(next) {
      script = next;
    },
    markCompactionBoundary() {
      const gate = canCompactAtBoundary({
        turnSettled: true,
        pendingExternalMutation,
      });
      if (!gate.ok) {
        throw new AppError({
          code: "runtime.compaction_blocked_pending_mutation",
          message: "Compaction cannot run while an external mutation is unresolved",
          context: { reason: gate.reason },
        });
      }
      compactionCount += 1;
      emit({
        kind: "compaction",
        role: params.role,
        reason: "threshold",
        provider: activeModel.provider,
        model: activeModel.model,
      });
      // Re-inject authoritative state (summary is advisory only).
      structuredState = {
        version: structuredState.version,
        payload: { ...structuredState.payload },
      };
      void structuredStateReinjectionPrompt(structuredState);
    },
    setPendingExternalMutation(pending) {
      pendingExternalMutation = pending;
    },
    pendingExternalMutation: () => pendingExternalMutation,
    compactionCount: () => compactionCount,
  };

  const session: PiSession = {
    role: params.role,
    get primary() {
      return activeModel;
    },
    async send(prompt, opts) {
      if (disposed) {
        throw new AppError({
          code: "runtime.session_disposed",
          message: "Pi session already disposed",
        });
      }
      if (aborted) {
        throw new AppError({
          code: "agent.session_aborted",
          message: "Agent runner session aborted",
        });
      }
      sends.push({ prompt, opts });
      emit({
        kind: "turn",
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: activeModel.provider,
        model: activeModel.model,
      });
      const text = await script({ prompt, opts, emit });
      const turn: AgentRunnerTurn = {
        text,
        prompt: promptMetadataFromText(prompt),
      };
      emit({
        kind: "completion",
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: activeModel.provider,
        model: activeModel.model,
        ok: true,
      });
      return turn;
    },
    setActiveTools(tools: readonly PiTool[], _executors: Record<string, AgentRunnerToolExecutor>) {
      activeToolNames = tools.map((tool) => tool.name);
      void activeToolNames;
    },
    restoreTools() {
      activeToolNames = [...allToolNames];
    },
    async abort() {
      aborted = true;
      emit({
        kind: "cancellation",
        role: params.role,
        provider: activeModel.provider,
        model: activeModel.model,
        reason: "abort",
      });
    },
    async dispose() {
      disposed = true;
    },
    async restartWithFallback(restartParams) {
      if (!params.fallback) {
        throw new AppError({
          code: "runtime.fallback_unavailable",
          message: "No fallback model assignment configured for this session",
          context: { role: params.role },
        });
      }
      await session.dispose();
      structuredState = restartParams.structuredState;
      activeModel = params.fallback;
      aborted = false;
      disposed = false;
      emit({
        kind: "retry",
        role: params.role,
        checkpointId: restartParams.checkpointId,
        provider: activeModel.provider,
        model: activeModel.model,
        reason: "fallback",
      });
      const next = createFakePiSession(
        {
          ...params,
          primary: params.fallback,
          structuredState,
        },
        script,
      );
      // Preserve control buffers for tests that hold the original controls reference.
      events.push(...next.controls.events);
      return next.session;
    },
    getStructuredState: () => structuredState,
    setStructuredState(state) {
      structuredState = state;
    },
    setExternalMutationPending(pending) {
      pendingExternalMutation = pending;
    },
    async compactIfNeeded(reason = "threshold") {
      if (!params.compactionPolicy.enabled) return false;
      const gate = canCompactAtBoundary({
        turnSettled: true,
        pendingExternalMutation,
      });
      if (!gate.ok) {
        throw new AppError({
          code: "runtime.compaction_blocked_pending_mutation",
          message: "Compaction cannot run while an external mutation is unresolved",
          context: { reason: gate.reason },
        });
      }
      controls.markCompactionBoundary();
      emit({
        kind: "turn",
        role: params.role,
        phase: "synthesis",
        checkpointId: "post-compaction",
        provider: activeModel.provider,
        model: activeModel.model,
      });
      void reason;
      return true;
    },
  };

  return { session, controls };
}
