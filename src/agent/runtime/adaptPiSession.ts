import type { AgentRunnerSendOptions, AgentRunnerSession } from "../providers/interface.js";
import type { AgentSessionPhase, PiSession } from "./types.js";

/**
 * Expand/migrate adapter so existing harness helpers that still speak
 * `AgentRunnerSession` can run on the Pi session seam.
 */
export function adaptPiSessionToAgentRunner(
  session: PiSession,
  defaultPhase: AgentSessionPhase,
): AgentRunnerSession {
  return {
    async send(prompt: string, opts?: AgentRunnerSendOptions) {
      const phase = opts?.phase ?? defaultPhase;
      return session.send(prompt, {
        phase,
        maxToolRounds: opts?.maxToolRounds,
        checkpointId: `${session.role}:${phase}`,
      });
    },
    abort: () => session.abort(),
    restrictToTools(tools, executors) {
      session.setActiveTools(tools, executors);
    },
    restoreTools: () => session.restoreTools(),
    dispose: () => session.dispose(),
  };
}
