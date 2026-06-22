import type {
  AgentRunnerSendOptions,
  AgentRunnerSession,
  AgentRunnerTurn,
} from "../../agent/providers/interface.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";

export function recordAgentTurnMetrics(turn: AgentRunnerTurn): void {
  recordReviewMetric({
    kind: "model_turn",
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
  });
}

export async function sendReviewAgentTurn(
  session: AgentRunnerSession,
  prompt: string,
  opts?: AgentRunnerSendOptions,
): Promise<AgentRunnerTurn> {
  const turn = await session.send(prompt, opts);
  recordAgentTurnMetrics(turn);
  return turn;
}
