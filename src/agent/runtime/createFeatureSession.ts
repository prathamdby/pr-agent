import type { DatabaseSync } from "node:sqlite";
import type { PiSessionCreateParams } from "./types.ts";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../settings/index.ts";
import { combineAbortSignals, type AgentRunnerToolExecutor } from "../providers/interface.ts";
import { createDurableLifecycleEventSink, resolveAgentEventsContext } from "./agentEventSink.ts";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.ts";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.ts";
import { attachReportObstacle } from "../feedback/reportObstacle.ts";
import { createPiSession } from "./piSession.ts";
import { compactionPolicyForRole } from "./compactionPolicy.ts";
import { DEFAULT_PROMPT_CACHE_POLICY } from "./promptCachePolicy.ts";
import {
  DEFAULT_TOOL_POLICY,
  type AgentLifecycleEvent,
  type AgentSessionRole,
  type ModelAssignment,
  type PiSession,
} from "./types.ts";

export type FeatureSessionContext = {
  readonly db?: DatabaseSync;
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
};

function attachSessionAbort(session: PiSession, sessionAbort: AbortController) {
  const originalAbort = session.abort.bind(session);
  return ((pinnedReturn: PiSession) => pinnedReturn)({
    ...session,
    abort: async () => {
      sessionAbort.abort();
      await originalAbort();
    },
  });
}

export async function createFeaturePiSession(params: {
  readonly createSession?: (params: PiSessionCreateParams) => PiSession | Promise<PiSession>;
  readonly role: AgentSessionRole;
  readonly traceRole?: "judge";
  readonly specialistId?: string;
  readonly cfg: Config;
  readonly systemPrompt: string;
  readonly systemPromptSharedHead?: string;
  readonly promptCacheKey?: string;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly durableTools?: PiSessionCreateParams["durableTools"];
  readonly toolMeta?: PiSessionCreateParams["toolMeta"];
  readonly codemode?: boolean;
  readonly ownership?: PiSessionCreateParams["ownership"];
  readonly providerSessionId?: string;
  readonly cwd?: string;
  readonly eventSink?: (event: AgentLifecycleEvent) => void;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly sessionContext?: FeatureSessionContext;
  readonly hostSignal?: AbortSignal;
  readonly attemptModel?: ModelAssignment;
}) {
  const policy = resolveModelPolicy(params.cfg);
  const primary = params.attemptModel ?? modelAssignmentForRole(policy, params.role);
  const agentEventsContext = resolveAgentEventsContext(params.cfg, params.sessionContext);
  const durableEventSink = agentEventsContext
    ? createDurableLifecycleEventSink(agentEventsContext, params.cfg)
    : null;
  const eventSink = (event: AgentLifecycleEvent) => {
    try {
      params.eventSink?.(event);
    } catch {}
    durableEventSink?.(event);
  };
  const sessionAbort = new AbortController();
  const executors: Record<string, AgentRunnerToolExecutor> = {};
  for (const [name, executor] of Object.entries(params.executors)) {
    executors[name] = (args, ctx) =>
      executor(args, {
        ...(ctx ?? { signal: sessionAbort.signal, toolCallId: "" }),
        signal: combineAbortSignals([ctx?.signal, sessionAbort.signal]),
      });
  }
  const attached = attachReportObstacle(
    { tools: params.tools, executors },
    agentEventsContext
      ? {
          ...(params.sessionContext?.db !== undefined ? { db: params.sessionContext.db } : {}),
          workItemId: agentEventsContext.workItemId,
          installationId: agentEventsContext.installationId,
          owner: agentEventsContext.owner,
          repo: agentEventsContext.repo,
          prNumber: agentEventsContext.prNumber,
          ...(agentEventsContext.executionId != null
            ? { executionId: agentEventsContext.executionId }
            : {}),
          ...(agentEventsContext.attemptCount != null
            ? { attemptCount: agentEventsContext.attemptCount }
            : {}),
          sessionRole: params.role,
          ...(params.specialistId ? { specialistId: params.specialistId } : {}),
          provider: primary.provider,
          model: primary.model,
        }
      : null,
  );
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
    ...(params.systemPromptSharedHead != null
      ? { systemPromptSharedHead: params.systemPromptSharedHead }
      : {}),
    ...(params.promptCacheKey != null ? { promptCacheKey: params.promptCacheKey } : {}),
    cwd: params.cwd,
    eventSink,
    cfg: params.cfg,
    tools: attached.tools,
    executors: attached.executors,
    ...(params.durableTools !== undefined ? { durableTools: params.durableTools } : {}),
    ...(params.toolMeta !== undefined ? { toolMeta: params.toolMeta } : {}),
    ...(params.codemode !== undefined ? { codemode: params.codemode } : {}),
    ...(params.ownership !== undefined ? { ownership: params.ownership } : {}),
    ...(params.providerSessionId !== undefined
      ? { providerSessionId: params.providerSessionId }
      : params.promptCacheKey != null
        ? { providerSessionId: params.promptCacheKey }
        : {}),
    refreshBeforeTool: params.refreshBeforeTool,
    hostSignal: params.hostSignal,
  });
  return ((pinnedReturn: PiSession | Promise<PiSession>) => pinnedReturn)(
    attachSessionAbort(session, sessionAbort),
  );
}
