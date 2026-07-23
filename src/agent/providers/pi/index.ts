import type {
  AgentRunnerProvider,
  AgentRunnerSendOptions,
  AgentRunnerSession,
} from "../interface.js";
import {
  createPiSession,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
} from "../../runtime/piSession.js";

/**
 * Expand-phase adapter: existing call sites keep using AgentRunnerProvider while
 * the Pi-specific session seam owns SDK construction.
 */
export const piAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({ cfg, cwd, systemPrompt, tools, executors, refreshBeforeTool }) {
    const session = await createPiSession({
      role: "ask",
      primary: { provider: cfg.piProvider, model: cfg.piModel },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: DEFAULT_COMPACTION_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      structuredState: EMPTY_STRUCTURED_STATE,
      systemPrompt,
      cwd,
      eventSink: () => undefined,
      cfg,
      tools,
      executors,
      refreshBeforeTool,
    });

    const adapted: AgentRunnerSession = {
      async send(prompt: string, opts?: AgentRunnerSendOptions) {
        return session.send(prompt, {
          phase: "ask",
          maxToolRounds: opts?.maxToolRounds,
          checkpointId: "legacy-agent-runner",
        });
      },
      abort: () => session.abort(),
      restrictToTools(nextTools, nextExecutors) {
        session.setActiveTools(nextTools, nextExecutors);
      },
      restoreTools: () => session.restoreTools(),
      dispose: () => session.dispose(),
    };
    return adapted;
  },
};
