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
  let structuredState = params.structuredState;
  let aborted = false;
  let disposed = false;

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
  };

  const session: PiSession = {
    role: params.role,
    primary: params.primary,
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
        provider: params.primary.provider,
        model: params.primary.model,
      });
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
      });
      return turn;
    },
    async abort() {
      aborted = true;
      emit({
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
    getStructuredState: () => structuredState,
    setStructuredState(state) {
      structuredState = state;
    },
  };

  return { session, controls };
}
