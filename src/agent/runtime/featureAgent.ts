import { createFeaturePiSession } from "./createFeatureSession.js";
import type { PiSessionSendOptions } from "./types.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Config, SUBMIT_ONLY_MAX_TOOL_ROUNDS } from "../../settings/index.js";
import type { AgentRunnerTurn } from "../providers/interface.js";
import type { PiSession } from "./types.js";

export function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: cfg.models.api,
    provider: provider || cfg.models.provider,
    model: cfg.models.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export type SubmitOnlySend = (
  session: PiSession,
  prompt: string,
  opts: { readonly maxToolRounds: number },
) => Promise<AgentRunnerTurn>;

const defaultSubmitOnlySend: SubmitOnlySend = (activeSession, activePrompt, opts) => {
  const phase = activeSession.role === "orchestrator" ? "synthesis" : activeSession.role;
  return activeSession.send(activePrompt, {
    phase,
    checkpointId: `${activeSession.role}:${phase}`,
    maxToolRounds: opts.maxToolRounds,
  });
};

/**
 * Send a submit-focused repair nudge without mutating the active tool list.
 * Tool definitions stay registered for the session lifetime (prompt-cache stability).
 */
export async function runSubmitOnlyRound(
  session: PiSession,
  prompt: string,
  send: SubmitOnlySend = defaultSubmitOnlySend,
): Promise<string> {
  return (await send(session, prompt, { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS })).text;
}

export type StructuredAgentPhase<TName extends string> = {
  readonly name: TName;
  readonly run: () => Promise<void>;
};

export async function runStructuredAgentLoop<TName extends string>(params: {
  readonly phases: readonly StructuredAgentPhase<TName>[];
  readonly shouldContinue: () => boolean;
  readonly onPhaseEnter?: (phase: TName) => void;
}): Promise<void> {
  for (const phase of params.phases) {
    if (!params.shouldContinue()) break;
    params.onPhaseEnter?.(phase.name);
    await phase.run();
  }
}

export async function runValidationRepairLoop(params: {
  readonly rounds: number;
  readonly shouldContinue: () => boolean;
  readonly getValidationError: () => string | null | undefined;
  readonly clearValidationError: () => void;
  readonly restoreValidationError?: (error: string) => void;
  readonly repair: (validationError: string) => Promise<void>;
}): Promise<void> {
  for (let repair = 0; repair < params.rounds && params.shouldContinue(); repair++) {
    const validationError = params.getValidationError();
    if (!validationError) break;
    params.clearValidationError();
    await params.repair(validationError);
    if (params.shouldContinue() && !params.getValidationError()) {
      params.restoreValidationError?.(validationError);
    }
  }
}

export type SubmitSpec<P> = {
  readonly state: { lastValidationError: string | null; payload?: P | null };
  readonly shouldContinue: () => boolean;
  readonly userContent: string;
  readonly investigation: PiSessionSendOptions;
  readonly finalize: PiSessionSendOptions;
  readonly nudge: string;
  readonly nudgeRounds: number;
  readonly repairRounds: number;
  readonly repairPrompt: (validationError: string) => string;
  /** Description keeps the last diagnostic turn rather than a failed nudge. */
  readonly preserveTextOnNudgeError?: boolean;
};

/** Own session lifetime and submit/repair ordering; tools stay registered. */
export async function runFeatureAgent<P>(
  spec: SubmitSpec<P>,
  rt: {
    readonly session: Parameters<typeof createFeaturePiSession>[0];
    readonly createSession?: typeof createFeaturePiSession;
  },
): Promise<{ readonly lastText: string }> {
  const session = await (rt.createSession ?? createFeaturePiSession)(rt.session);
  let lastText = "";
  const repair = () =>
    runValidationRepairLoop({
      rounds: spec.repairRounds,
      shouldContinue: spec.shouldContinue,
      getValidationError: () => spec.state.lastValidationError,
      clearValidationError: () => {
        spec.state.lastValidationError = null;
      },
      restoreValidationError: (error) => {
        spec.state.lastValidationError = error;
      },
      repair: async (error) => {
        lastText = (await session.send(spec.repairPrompt(error), spec.finalize)).text;
      },
    });
  try {
    await runStructuredAgentLoop({
      shouldContinue: spec.shouldContinue,
      phases: [
        {
          name: "investigation",
          run: async () => {
            lastText = (await session.send(spec.userContent, spec.investigation)).text;
          },
        },
        {
          name: "pre_submit",
          run: async () => {
            for (let nudge = 0; nudge < spec.nudgeRounds && spec.shouldContinue(); nudge++) {
              const text = (await session.send(spec.nudge, spec.finalize)).text;
              if (!spec.preserveTextOnNudgeError || !spec.state.lastValidationError)
                lastText = text;
              await repair();
            }
          },
        },
        { name: "validation_repair", run: repair },
      ],
    });
    return { lastText };
  } finally {
    await session.dispose();
  }
}
