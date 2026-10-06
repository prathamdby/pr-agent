import type { Pool, PoolClient } from "pg";
import type { PiSessionCreateParams } from "./types.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../settings/index.js";
import { combineAbortSignals, type AgentRunnerToolExecutor } from "../providers/interface.js";
import { createDurableLifecycleEventSink, resolveAgentEventsContext } from "./agentEventSink.js";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.js";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.js";
import { CODE_MODE_EXECUTE_NAME } from "../codemode/types.js";
import { createPiSession } from "./piSession.js";
import { compactionPolicyForRole } from "./compactionPolicy.js";
import { DEFAULT_PROMPT_CACHE_POLICY } from "./promptCachePolicy.js";
import {
  DEFAULT_TOOL_POLICY,
  type AgentLifecycleEvent,
  type AgentSessionRole,
  type ModelAssignment,
  type PiSession,
} from "./types.js";

export type FeatureSessionContext = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
};

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

export async function createFeaturePiSession(params: {
  readonly createSession?: (params: PiSessionCreateParams) => PiSession | Promise<PiSession>;
  readonly role: AgentSessionRole;
  readonly traceRole?: "judge";
  readonly specialistId?: string;
  readonly cfg: Config;
  readonly systemPrompt: string;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly cwd?: string;
  readonly eventSink?: (event: AgentLifecycleEvent) => void;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly sessionContext?: Omit<FeatureSessionContext, "pool"> & {
    readonly pool: Pool | PoolClient;
  };
  /** Durable job/lease abort; combined with the session abort and the loop signal. */
  readonly hostSignal?: AbortSignal;
  /** Model this durable attempt runs on; defaults to the role policy when omitted. */
  readonly attemptModel?: ModelAssignment;
}): Promise<PiSession> {
  const policy = resolveModelPolicy(params.cfg);
  const primary = params.attemptModel ?? modelAssignmentForRole(policy, params.role);
  const agentEventsContext = resolveAgentEventsContext(params.cfg, params.sessionContext);
  const durableEventSink = agentEventsContext
    ? createDurableLifecycleEventSink(agentEventsContext, params.cfg)
    : null;
  const eventSink = (event: AgentLifecycleEvent): void => {
    try {
      params.eventSink?.(event);
    } catch {
      // Custom observers must not suppress the independent telemetry sink.
    }
    durableEventSink?.(event);
  };
  const executors = { ...params.executors };
  const execute = executors[CODE_MODE_EXECUTE_NAME];
  const sessionAbort = new AbortController();
  if (execute) {
    executors[CODE_MODE_EXECUTE_NAME] = async (args, ctx?) =>
      execute(args, {
        signal: combineAbortSignals([ctx?.signal, sessionAbort.signal, params.hostSignal]),
        toolCallId: ctx?.toolCallId ?? CODE_MODE_EXECUTE_NAME,
        emit: (event) => {
          ctx?.emit?.(event);
          eventSink(event);
        },
        role: params.role,
        provider: primary.provider,
        model: primary.model,
      });
  }
  const session = await (params.createSession ?? createPiSession)({
    role: params.role,
    traceWorkItemId: params.sessionContext?.workItemId,
    traceRole: params.traceRole,
    ...(params.specialistId ? { specialistId: params.specialistId } : {}),
    primary,
    thinkingPolicy: thinkingPolicyFromCeiling(params.cfg.models.thinkingCeiling),
    compactionPolicy: compactionPolicyForRole(params.role),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink,
    cfg: params.cfg,
    tools: params.tools,
    executors,
    refreshBeforeTool: params.refreshBeforeTool,
    hostSignal: params.hostSignal,
  });
  return attachSessionAbort(session, sessionAbort);
}
