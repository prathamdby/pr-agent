import type { AgentRunnerSession } from "../../agent/providers/interface.js";
import { logWarn } from "../../evlog.js";

/**
 * One cancellation owner for every active Review session (KTD6). Superseding or
 * cancellation must abort evidence, critics, validation, and synthesis together.
 */
export type ReviewSessionRegistry = {
  readonly register: (session: AgentRunnerSession) => () => void;
  readonly cancelAll: () => Promise<void>;
};

export function createReviewSessionRegistry(): ReviewSessionRegistry {
  const sessions = new Set<AgentRunnerSession>();
  return {
    register(session) {
      sessions.add(session);
      return () => {
        sessions.delete(session);
      };
    },
    async cancelAll() {
      const active = [...sessions];
      sessions.clear();
      await Promise.all(
        active.map((session) =>
          session.cancel().catch((error: unknown) => {
            logWarn("review_session_cancel_failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }),
        ),
      );
    },
  };
}
