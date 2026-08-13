import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { createDurableLifecycleEventSink, resolveAgentEventsContext } from "./agentEventSink.js";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.js";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.js";
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
  type PiSession,
  type PiSessionCreateParams,
  type PiSessionSendOptions,
} from "./types.js";

type MutablePiSessionCreateParams = {
  -readonly [K in keyof PiSessionCreateParams]: PiSessionCreateParams[K];
};

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

export type CreateFeaturePiSessionParams = {
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
};

export type CreateFeaturePiSession = (params: CreateFeaturePiSessionParams) => Promise<PiSession>;

async function createFeaturePiSessionImpl(
  params: CreateFeaturePiSessionParams,
): Promise<PiSession> {
  const policy = resolveModelPolicy(params.cfg);
  const primary = modelAssignmentForRole(policy, params.role);
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
  const sessionParams: MutablePiSessionCreateParams = {
    role: params.role,
    primary,
    fallback: policy.fallback,
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
    executors: params.executors,
    refreshBeforeTool: params.refreshBeforeTool,
  };
  if (params.specialistId) sessionParams.specialistId = params.specialistId;
  const session = await createPiSession(sessionParams);
  if (!params.durability) return session;
  return wrapSessionWithDurability(session, params.cfg, params.durability);
}

let activeCreateFeaturePiSession: CreateFeaturePiSession = createFeaturePiSessionImpl;

export function setCreateFeaturePiSession(create: CreateFeaturePiSession): void {
  activeCreateFeaturePiSession = create;
}

export function resetCreateFeaturePiSession(): void {
  activeCreateFeaturePiSession = createFeaturePiSessionImpl;
}

export async function createFeaturePiSession(
  params: CreateFeaturePiSessionParams,
): Promise<PiSession> {
  return activeCreateFeaturePiSession(params);
}
