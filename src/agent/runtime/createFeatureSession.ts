import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { combineAbortSignals, type AgentRunnerToolExecutor } from "../providers/interface.js";
import { createDurableLifecycleEventSink, resolveAgentEventsContext } from "./agentEventSink.js";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.js";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.js";
import { CODE_MODE_EXECUTE_NAME } from "../codemode/types.js";
import { createPiSession } from "./piSession.js";
import {
  commitPhaseCheckpoint,
  resolveDurableStructuredState,
  saveResumeSnapshotIfConfigured,
  type FeatureSessionDurability,
} from "./sessionDurability.js";
import { compactionPolicyForRole } from "./compactionPolicy.js";
import { DEFAULT_PROMPT_CACHE_POLICY } from "./promptCachePolicy.js";
import {
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  type AgentLifecycleEvent,
  type AgentSessionRole,
  type AuthoritativeStructuredState,
  type ModelAssignment,
  type PiSession,
  type PiSessionSendOptions,
} from "./types.js";

export type { FeatureSessionDurability } from "./sessionDurability.js";

async function resolveInitialStructuredState(params: {
  readonly role: AgentSessionRole;
  readonly cfg: Config;
  readonly structuredState?: AuthoritativeStructuredState;
  readonly durability?: FeatureSessionDurability;
}): Promise<AuthoritativeStructuredState> {
  if (!params.durability) {
    return params.structuredState ?? EMPTY_STRUCTURED_STATE;
  }
  return resolveDurableStructuredState({
    role: params.role,
    cfg: params.cfg,
    structuredState: params.structuredState,
    durability: params.durability,
  });
}

function attachSessionAbort(session: PiSession, sessionAbort: AbortController): PiSession {
  const originalAbort = session.abort.bind(session);
  return {
    ...session,
    abort: async () => {
      sessionAbort.abort();
      await originalAbort();
    },
  };
}

function wrapSessionWithDurability(
  session: PiSession,
  cfg: Config,
  durability: FeatureSessionDurability,
): PiSession {
  const originalSend = session.send.bind(session);
  return {
    ...session,
    send: async (prompt: string, opts: PiSessionSendOptions) => {
      const result = await originalSend(prompt, opts);
      try {
        const structuredState = session.getStructuredState();
        await commitPhaseCheckpoint(durability.pool, {
          workItemId: durability.workItemId,
          sessionRole: session.role,
          checkpointId: opts.checkpointId,
          phase: opts.phase,
          structuredState,
        });
        await saveResumeSnapshotIfConfigured(durability.pool, cfg, {
          workItemId: durability.workItemId,
          sessionRole: session.role,
          installationId: durability.installationId,
          modelProvider: session.primary.provider,
          modelId: session.primary.model,
          checkpointId: opts.checkpointId,
          plaintext: {
            conversation: { lastPhase: opts.phase, lastCheckpointId: opts.checkpointId },
            structuredState,
          },
        });
      } catch (error) {
        logWarn("session_durability_persist_failed", {
          workItemId: durability.workItemId,
          sessionRole: session.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    },
  };
}

export async function createFeaturePiSession(params: {
  readonly role: AgentSessionRole;
  readonly specialistId?: string;
  readonly cfg: Config;
  readonly systemPrompt: string;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly cwd?: string;
  readonly structuredState?: AuthoritativeStructuredState;
  readonly eventSink?: (event: AgentLifecycleEvent) => void;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly durability?: FeatureSessionDurability;
  /** Durable job/lease abort; combined with the session abort and the loop signal. */
  readonly hostSignal?: AbortSignal;
  /** Model this durable attempt runs on; defaults to the role policy when omitted. */
  readonly attemptModel?: ModelAssignment;
}): Promise<PiSession> {
  const policy = resolveModelPolicy(params.cfg);
  const primary = params.attemptModel ?? modelAssignmentForRole(policy, params.role);
  const structuredState = await resolveInitialStructuredState(params);
  const agentEventsContext = resolveAgentEventsContext(params.cfg, params.durability);
  const durableEventSink = agentEventsContext
    ? createDurableLifecycleEventSink(agentEventsContext, params.cfg)
    : null;
  const eventSink =
    durableEventSink && params.eventSink
      ? (event: AgentLifecycleEvent) => {
          params.eventSink?.(event);
          durableEventSink(event);
        }
      : (durableEventSink ?? params.eventSink ?? (() => undefined));
  const executors = { ...params.executors };
  const execute = executors[CODE_MODE_EXECUTE_NAME];
  const sessionAbort = new AbortController();
  if (execute) {
    executors[CODE_MODE_EXECUTE_NAME] = async (args, ctx?) =>
      execute(args, {
        signal: combineAbortSignals([ctx?.signal, sessionAbort.signal, params.hostSignal]),
        toolCallId: ctx?.toolCallId ?? CODE_MODE_EXECUTE_NAME,
        emit: eventSink,
        role: params.role,
        provider: primary.provider,
        model: primary.model,
      });
  }
  const session = await createPiSession({
    role: params.role,
    ...(params.specialistId ? { specialistId: params.specialistId } : {}),
    primary,
    thinkingPolicy: thinkingPolicyFromCeiling(params.cfg.piThinkingCeiling),
    compactionPolicy: compactionPolicyForRole(params.role),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink,
    cfg: params.cfg,
    tools: params.tools,
    executors,
    refreshBeforeTool: params.refreshBeforeTool,
    hostSignal: params.hostSignal,
  });
  const durable = params.durability
    ? wrapSessionWithDurability(session, params.cfg, params.durability)
    : session;
  return attachSessionAbort(durable, sessionAbort);
}
