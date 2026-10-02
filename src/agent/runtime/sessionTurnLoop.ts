import {
  runAgentLoop,
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  SESSION_TURN_RETRY_BASE_DELAY_MS,
  SESSION_TURN_RETRY_MAX,
} from "../../settings/sessionConstants.js";
import { sleepForRetry, type createSendActivity } from "./sendActivity.js";
import type { createSessionCompaction } from "./sessionCompaction.js";
import { dropTrailingErrorAssistant } from "./transcriptCompaction.js";

type SessionTurnRuntime = {
  readonly context: AgentContext;
  readonly config: AgentLoopConfig;
  readonly streamFn: StreamFn;
  readonly signal: AbortSignal;
  readonly handleEvent: (event: AgentEvent) => void;
  readonly activity: ReturnType<typeof createSendActivity>;
  readonly compaction: ReturnType<typeof createSessionCompaction>;
  readonly shouldContinue: () => boolean;
  readonly onRetry: (attempt: number) => void;
};

export function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function placeUserMessage(
  target: AgentMessage[],
  userMessage: AgentMessage,
  insertAt: number,
): void {
  const userIndex = target.indexOf(userMessage);
  if (userIndex === -1) {
    target.splice(insertAt, 0, userMessage);
    return;
  }
  if (userIndex > insertAt) {
    target.splice(userIndex, 1);
    target.splice(Math.min(insertAt, target.length), 0, userMessage);
  }
}

/**
 * Core copies `context.messages` on `runAgentLoop` and returns the new turn
 * slice in order. Replace the session suffix with that slice so tool results
 * stay between the assistant turns that produced them. Empty `produced` keeps
 * event-appended assistants (test mocks and a loop that returned nothing).
 */
function absorbProducedMessages(
  target: AgentMessage[],
  produced: readonly AgentMessage[],
  userMessage: AgentMessage,
  newContentStart: number,
): void {
  const insertAt = Math.min(Math.max(newContentStart, 0), target.length);
  if (produced.length > 0) {
    target.splice(insertAt, target.length - insertAt, ...produced);
  }
  placeUserMessage(target, userMessage, insertAt);
}

/** Own transcript adoption, overflow-before-retry ordering, and capped continuation. */
export async function runSessionTurn(
  prompt: string,
  rt: SessionTurnRuntime,
): Promise<{ loopError: unknown }> {
  const messages = rt.context.messages;
  const transcriptLengthAtSend = messages.length;
  const userMessage: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };
  const continueLoop = async () => {
    const newContentStart = messages.length;
    const produced = await runAgentLoopContinue(
      rt.context,
      rt.config,
      rt.handleEvent,
      rt.signal,
      rt.streamFn,
    );
    absorbProducedMessages(messages, produced, userMessage, newContentStart);
  };
  let loopError: unknown;
  let turnRetries = 0;
  try {
    const work = (async () => {
      const produced = await runAgentLoop(
        [userMessage],
        rt.context,
        rt.config,
        rt.handleEvent,
        rt.signal,
        rt.streamFn,
      );
      absorbProducedMessages(messages, produced, userMessage, transcriptLengthAtSend);
    })();
    await rt.activity.run(work);
  } catch (error) {
    loopError = error;
  }
  while (rt.shouldContinue()) {
    const assistant = lastAssistant(messages);
    if (!assistant || assistant.stopReason !== "error") break;
    if (isContextOverflow(assistant, rt.config.model.contextWindow)) {
      if (!(await rt.compaction.recoverOverflow(messages))) break;
      try {
        await rt.activity.run(continueLoop());
        loopError = undefined;
      } catch (error) {
        loopError = error;
        break;
      }
      continue;
    }
    if (!isRetryableAssistantError(assistant) || turnRetries >= SESSION_TURN_RETRY_MAX) break;
    dropTrailingErrorAssistant(messages);
    turnRetries += 1;
    rt.onRetry(turnRetries);
    try {
      await sleepForRetry(SESSION_TURN_RETRY_BASE_DELAY_MS * 2 ** (turnRetries - 1), rt.signal);
      await rt.activity.run(continueLoop());
      loopError = undefined;
    } catch (error) {
      loopError = error;
      break;
    }
  }
  return { loopError };
}
