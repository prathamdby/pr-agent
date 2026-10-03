import { randomUUID } from "node:crypto";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerTurn, TurnEnd } from "../providers/interface.js";
import { promptMetadataFromText } from "../providers/usageMetadata.js";
import type {
  AgentLifecycleEvent,
  PiSession,
  PiSessionCreateParams,
  PiSessionSendOptions,
} from "./types.js";

type FakePiSessionReply = string | { readonly text: string; readonly end: TurnEnd };

export type FakePiSessionScript = (ctx: {
  readonly prompt: string;
  readonly opts: PiSessionSendOptions;
  readonly emit: (event: AgentLifecycleEvent) => void;
}) => Promise<FakePiSessionReply> | FakePiSessionReply;

export type FakePiSessionControls = {
  readonly events: AgentLifecycleEvent[];
  readonly sends: Array<{ prompt: string; opts: PiSessionSendOptions }>;
  readonly setScript: (script: FakePiSessionScript) => void;
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
  let aborted = false;
  let disposed = false;
  const sessionId = randomUUID();

  const emitForGeneration = (generationId?: string) => (event: AgentLifecycleEvent) => {
    const correlated = {
      ...event,
      sessionId,
      ...(generationId != null ? { generationId } : {}),
      ...(params.specialistId != null ? { specialistId: params.specialistId } : {}),
    };
    events.push(correlated);
    try {
      params.eventSink(correlated);
    } catch {
      // Match the real runtime's best-effort observers.
    }
  };
  const emitSession = emitForGeneration();

  const controls: FakePiSessionControls = {
    events,
    sends,
    setScript(next) {
      script = next;
    },
  };

  const session: PiSession = {
    role: params.role,
    primary: params.primary,
    async send(prompt, opts) {
      if (disposed) {
        throw new AppError({
          domain: "runtime",
          kind: "session_disposed",
          message: "Pi session already disposed",
        });
      }
      if (aborted) {
        throw new AppError({
          domain: "agent",
          kind: "session_aborted",
          message: "Agent runner session aborted",
        });
      }
      const emit = emitForGeneration(randomUUID());
      const startedAt = Date.now();
      sends.push({ prompt, opts });
      emit({
        kind: "turn",
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: params.primary.provider,
        model: params.primary.model,
      });
      try {
        const reply = await script({ prompt, opts, emit });
        const { text, end }: { text: string; end: TurnEnd } =
          typeof reply === "string" ? { text: reply, end: "completed" } : reply;
        const turn: AgentRunnerTurn = {
          text,
          end,
          prompt: promptMetadataFromText(prompt),
        };
        emit({
          kind: "completion",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: params.primary.provider,
          model: params.primary.model,
          ok: true,
          end,
          durationMs: Date.now() - startedAt,
        });
        return turn;
      } catch (error) {
        emit({
          kind: "failure",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: params.primary.provider,
          model: params.primary.model,
          ok: false,
          failureCode: error instanceof AppError ? error.code : "runtime.session_send_failed",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
    async abort() {
      aborted = true;
      emitSession({
        kind: "cancellation",
        role: params.role,
        provider: params.primary.provider,
        model: params.primary.model,
        reason: "abort",
      });
    },
    async dispose() {
      disposed = true;
    },
  };

  return { session, controls };
}
