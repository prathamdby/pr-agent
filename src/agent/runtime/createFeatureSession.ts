import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { thinkingPolicyFromCeiling } from "./thinkingPolicy.js";
import { modelAssignmentForRole, resolveModelPolicy } from "./modelPolicy.js";
import { createPiSession } from "./piSession.js";
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  type AgentLifecycleEvent,
  type AgentSessionRole,
  type AuthoritativeStructuredState,
  type PiSession,
} from "./types.js";

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
}): Promise<PiSession> {
  const policy = resolveModelPolicy(params.cfg);
  const primary = modelAssignmentForRole(policy, params.role);
  return createPiSession({
    role: params.role,
    primary,
    fallback: policy.fallback,
    thinkingPolicy: thinkingPolicyFromCeiling(params.cfg.piThinkingCeiling),
    compactionPolicy: DEFAULT_COMPACTION_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState: params.structuredState ?? EMPTY_STRUCTURED_STATE,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink: params.eventSink ?? (() => undefined),
    cfg: params.cfg,
    tools: params.tools,
    executors: params.executors,
    refreshBeforeTool: params.refreshBeforeTool,
  });
}
