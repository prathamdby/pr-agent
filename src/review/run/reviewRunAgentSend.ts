import type {
  AgentRunnerSendOptions,
  AgentRunnerSession,
  AgentRunnerTurn,
} from "../../agent/providers/interface.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import type { ReviewSessionRole } from "./reviewSessionRole.js";

export function recordAgentTurnMetrics(
  turn: AgentRunnerTurn,
  sessionRole: ReviewSessionRole,
): void {
  recordReviewMetric({
    kind: "model_turn",
    sessionRole,
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
  });
}

export async function sendReviewAgentTurn(
  session: AgentRunnerSession,
  prompt: string,
  opts?: AgentRunnerSendOptions,
  sessionRole: ReviewSessionRole = "orchestrator",
): Promise<AgentRunnerTurn> {
  const turn = await session.send(prompt, opts);
  recordAgentTurnMetrics(turn, sessionRole);
  return turn;
}
