import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.js";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.js";
import { createPiSession } from "./piSession.js";
import {
  commitPhaseCheckpoint,
  loadResumeSnapshotIfConfigured,
  saveResumeSnapshotIfConfigured,
  type FeatureSessionDurability,
} from "./sessionDurability.js";
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  type AgentLifecycleEvent,
  type AgentSessionRole,
  type AuthoritativeStructuredState,
  type PiSession,
  type PiSessionSendOptions,
} from "./types.js";

export type { FeatureSessionDurability } from "./sessionDurability.js";

function isAuthoritativeStructuredState(value: unknown): value is AuthoritativeStructuredState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "number" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

async function resolveInitialStructuredState(params: {
  readonly role: AgentSessionRole;
  readonly cfg: Config;
  readonly structuredState?: AuthoritativeStructuredState;
  readonly durability?: FeatureSessionDurability;
}): Promise<AuthoritativeStructuredState> {
  if (!params.durability) {
    return params.structuredState ?? EMPTY_STRUCTURED_STATE;
  }

  const loaded = await loadResumeSnapshotIfConfigured(params.durability.pool, params.cfg, {
    workItemId: params.durability.workItemId,
    sessionRole: params.role,
    expectedInstallationId: params.durability.installationId,
  });
  if (!loaded.ok) {
    return params.structuredState ?? EMPTY_STRUCTURED_STATE;
  }
  if (!isAuthoritativeStructuredState(loaded.plaintext.structuredState)) {
    return params.structuredState ?? EMPTY_STRUCTURED_STATE;
  }

  return {
    version: loaded.plaintext.structuredState.version,
    payload: {
      ...loaded.plaintext.structuredState.payload,
      __resumeCheckpointId: loaded.checkpointId,
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
  readonly cfg: Config;
  readonly systemPrompt: string;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly cwd?: string;
  readonly structuredState?: AuthoritativeStructuredState;
  readonly eventSink?: (event: AgentLifecycleEvent) => void;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly durability?: FeatureSessionDurability;
}): Promise<PiSession> {
  const policy = resolveModelPolicy(params.cfg);
  const primary = modelAssignmentForRole(policy, params.role);
  const structuredState = await resolveInitialStructuredState(params);
  const session = await createPiSession({
    role: params.role,
    primary,
    fallback: policy.fallback,
    thinkingPolicy: thinkingPolicyFromCeiling(params.cfg.piThinkingCeiling),
    compactionPolicy: DEFAULT_COMPACTION_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink: params.eventSink ?? (() => undefined),
    cfg: params.cfg,
    tools: params.tools,
    executors: params.executors,
    refreshBeforeTool: params.refreshBeforeTool,
  });
  if (!params.durability) return session;
  return wrapSessionWithDurability(session, params.cfg, params.durability);
}
