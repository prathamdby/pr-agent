import {
  runAgentLoop,
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  getSupportedThinkingLevels,
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { AppError, toAppError } from "../../errors/appError.js";
import {
  SESSION_OVERFLOW_COMPACT_MAX,
  SESSION_TURN_RETRY_BASE_DELAY_MS,
  SESSION_TURN_RETRY_MAX,
} from "../../settings/sessionConstants.js";
import {
  assertPhaseToolAllowed,
  ORCHESTRATOR_PHASE_TOOLS,
  type OrchestratorPhaseTool,
} from "../../review/orchestrator/phaseToolPolicy.js";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import { combineAbortSignals } from "../providers/interface.js";
import {
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../providers/usageMetadata.js";
import { toCoreTools } from "./coreTools.js";
import { createSanitizedEventSink } from "./lifecycleSanitizer.js";
import { cacheIdentityFromAssignment, sessionCacheIdFromIdentity } from "./promptCachePolicy.js";
import { createSessionModels } from "./sessionModels.js";
import { createSessionStreamFn } from "./sessionStream.js";
import { resolveThinkingLevel } from "./thinkingPolicy.js";
import { compactAgentMessages, compactIfNeeded } from "./transcriptCompaction.js";
import type { AuthoritativeStructuredState, PiSession, PiSessionCreateParams } from "./types.js";

function isOrchestratorPhaseTool(name: string): name is OrchestratorPhaseTool {
  return (ORCHESTRATOR_PHASE_TOOLS as readonly string[]).includes(name);
}

function assistantMessageText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return contentText(message.content).trim();
}

function asAssistantMessage(message: AgentMessage | undefined): AssistantMessage | undefined {
  if (!message || message.role !== "assistant") return undefined;
  return message;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      converted.push(message);
    }
  }
  return converted;
}

function dropTrailingErrorAssistant(messages: AgentMessage[]): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && "stopReason" in last && last.stopReason === "error") {
    messages.pop();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asAssistantMessage(messages[index]);
    if (message) return message;
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

export async function createPiSessionImpl(params: PiSessionCreateParams): Promise<PiSession> {
  let structuredState: AuthoritativeStructuredState = params.structuredState;
  const emit = createSanitizedEventSink(params.eventSink);
  const sessionAbort = new AbortController();
  const sessionMessages: AgentMessage[] = [];
  const sessionCacheId = sessionCacheIdFromIdentity(
    cacheIdentityFromAssignment(params.role, params.primary, params.specialistId),
  );

  const { models } = await createSessionModels(params.cfg);
  const model = models.getModel(params.primary.provider, params.primary.model);
  if (!model) {
    throw new AppError({
      code: "provider.model_not_found",
      message: params.cfg.modelsJsonPath
        ? `Model not found: ${params.primary.provider}/${params.primary.model} (models.json: ${params.cfg.modelsJsonPath})`
        : `Model not found: ${params.primary.provider}/${params.primary.model}`,
      context: {
        piProvider: params.primary.provider,
        piModel: params.primary.model,
        ...(params.cfg.modelsJsonPath ? { modelsJsonPath: params.cfg.modelsJsonPath } : {}),
      },
    });
  }

  const tools = toCoreTools(
    params.tools,
    params.executors,
    params.hostSignal,
    params.refreshBeforeTool,
  );
  const { streamFn } = createSessionStreamFn(models, {
    cacheRetention: params.promptCachePolicy.retention,
    sessionId: sessionCacheId,
    timeoutMs: params.cfg.providerPromptTimeoutMs,
    maxRetries: params.cfg.piProviderRetryMax,
    maxRetryDelayMs: params.cfg.piProviderMaxRetryDelayMs,
  });

  let abortPromise: Promise<void> | undefined;
  const abort = (): Promise<void> => {
    abortPromise ??= (async () => {
      sessionAbort.abort();
      emit({
        kind: "cancellation",
        role: params.role,
        provider: params.primary.provider,
        model: params.primary.model,
        reason: "abort",
      });
    })();
    return abortPromise;
  };

  const piSession: PiSession = {
    role: params.role,
    primary: params.primary,
    async send(prompt, opts) {
      if (abortPromise) {
        throw new AppError({
          code: "agent.session_aborted",
          message: "Agent runner session aborted",
        });
      }
      const sendAbort = new AbortController();
      const loopSignal = combineAbortSignals([
        sessionAbort.signal,
        sendAbort.signal,
        params.hostSignal,
      ]);
      const phaseRef = { current: opts.phase };
      let protocolInvalid = false;
      let sessionToolTurnCount = 0;
      let finalText = "";
      let terminalProviderError: string | undefined;
      let toolBudgetStopped = false;
      let aggregatedUsage: ReturnType<typeof exactUsageFromProviderUsage> | undefined;
      const idleTimeoutMs = opts.deadlineMs ?? params.cfg.providerPromptTimeoutMs;
      const idleTimeoutEnabled = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0;
      let idleCheckHandle: ReturnType<typeof setInterval> | undefined;
      let rejectOnIdle: ((error: Error) => void) | undefined;
      let lastActivityAt = Date.now();
      let idleRejected = false;
      const markActivity = () => {
        lastActivityAt = Date.now();
      };
      const rejectForIdle = () => {
        if (idleRejected) return;
        idleRejected = true;
        sendAbort.abort();
        rejectOnIdle?.(
          new AppError({
            code: "pi.prompt_idle_timeout",
            message: `Provider prompt timeout: no activity for ${idleTimeoutMs}ms`,
          }),
        );
      };
      const startIdleTimer = () => {
        const checkEveryMs = Math.max(1, Math.min(idleTimeoutMs, 1000));
        idleCheckHandle = setInterval(() => {
          if (Date.now() - lastActivityAt >= idleTimeoutMs) {
            rejectForIdle();
          }
        }, checkEveryMs);
      };

      const thinking = resolveThinkingLevel({
        policy: params.thinkingPolicy,
        phase: opts.phase,
        modelSupportedLevels: getSupportedThinkingLevels(model),
      });
      const context: AgentContext = {
        systemPrompt: params.systemPrompt,
        messages: sessionMessages,
        tools,
      };
      const config: AgentLoopConfig = {
        model,
        convertToLlm,
        getApiKey: async (provider) => {
          try {
            const auth = await models.getAuth(provider);
            return auth?.auth.apiKey;
          } catch {
            return undefined;
          }
        },
        cacheRetention: params.promptCachePolicy.retention,
        sessionId: sessionCacheId,
        timeoutMs: params.cfg.providerPromptTimeoutMs,
        maxRetries: params.cfg.piProviderRetryMax,
        maxRetryDelayMs: params.cfg.piProviderMaxRetryDelayMs,
        ...(thinking === "off" ? {} : { reasoning: thinking }),
        shouldStopAfterTurn: ({ toolResults }) => {
          if (opts.maxToolRounds == null) return false;
          return (
            toolBudgetStopped ||
            (toolResults.length > 0 && sessionToolTurnCount >= opts.maxToolRounds)
          );
        },
        beforeToolCall: async ({ assistantMessage, toolCall }) => {
          const calls = assistantMessage.content.filter((part) => part.type === "toolCall");
          const ids = calls.map((call) => call.id);
          if (new Set(ids).size !== ids.length) {
            protocolInvalid = true;
            return {
              block: true,
              reason: "Duplicate tool call id in one assistant message.",
              terminate: true,
            };
          }
          if (isOrchestratorPhaseTool(toolCall.name)) {
            const gate = assertPhaseToolAllowed(phaseRef.current, toolCall.name);
            if (!gate.ok) {
              return { block: true, reason: gate.error };
            }
          }
          return undefined;
        },
        ...(params.compactionPolicy.enabled
          ? {
              prepareNextTurn: async ({ context: turnContext }) => {
                const compacted = await compactIfNeeded({
                  messages: turnContext.messages,
                  model,
                  streamFn,
                  signal: loopSignal,
                });
                if (!compacted) return undefined;
                emit({
                  kind: "compaction",
                  role: params.role,
                  provider: params.primary.provider,
                  model: params.primary.model,
                  reason: "window",
                });
                turnContext.messages.length = 0;
                turnContext.messages.push(...compacted);
                return { context: turnContext };
              },
            }
          : {}),
      };

      const handleEvent = (event: AgentEvent) => {
        if (
          event.type === "message_update" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end" ||
          event.type === "turn_end"
        ) {
          markActivity();
        }
        if (event.type === "tool_execution_start") {
          emit({
            kind: "tool",
            role: params.role,
            phase: opts.phase,
            toolName: event.toolName,
            checkpointId: opts.checkpointId,
            provider: params.primary.provider,
            model: params.primary.model,
          });
        }
        if (event.type !== "turn_end") return;
        sessionToolTurnCount += 1;
        const assistant = asAssistantMessage(event.message);
        if (assistant && !sessionMessages.includes(assistant)) {
          sessionMessages.push(assistant);
        }
        if (assistant) {
          if (assistant.stopReason === "error" && assistant.errorMessage?.trim()) {
            terminalProviderError = assistant.errorMessage;
          } else if (assistant.stopReason !== "error") {
            terminalProviderError = undefined;
          }
          if (assistant.usage) {
            aggregatedUsage = mergeExactUsage(
              aggregatedUsage,
              exactUsageFromProviderUsage(assistant.usage),
            );
            emit({
              kind: "usage",
              role: params.role,
              phase: opts.phase,
              provider: params.primary.provider,
              model: params.primary.model,
            });
          }
        }
        if (event.toolResults.length === 0) {
          finalText = assistantMessageText(event.message);
        } else if (opts.maxToolRounds != null && sessionToolTurnCount >= opts.maxToolRounds) {
          toolBudgetStopped = true;
        }
      };

      emit({
        kind: "turn",
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: params.primary.provider,
        model: params.primary.model,
      });

      let sendStartedAt: number | undefined;
      let overflowCompacts = 0;
      let turnRetries = 0;
      try {
        sendStartedAt = Date.now();
        const transcriptLengthAtSend = sessionMessages.length;
        const userMessage: AgentMessage = {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        };
        const runIdle = async (work: Promise<void>) => {
          if (idleTimeoutEnabled) {
            const idle = new Promise<never>((_, reject) => {
              rejectOnIdle = reject;
              markActivity();
              startIdleTimer();
            });
            await Promise.race([work, idle]);
            return;
          }
          await work;
        };

        const continueLoop = async () => {
          const newContentStart = sessionMessages.length;
          const produced = await runAgentLoopContinue(
            context,
            config,
            handleEvent,
            loopSignal,
            streamFn,
          );
          absorbProducedMessages(sessionMessages, produced, userMessage, newContentStart);
        };

        let loopError: unknown;
        try {
          const work = (async () => {
            const produced = await runAgentLoop(
              [userMessage],
              context,
              config,
              handleEvent,
              loopSignal,
              streamFn,
            );
            absorbProducedMessages(sessionMessages, produced, userMessage, transcriptLengthAtSend);
          })();
          void work.catch(() => undefined);
          await runIdle(work);
        } catch (error) {
          loopError = error;
        }

        while (!abortPromise && !idleRejected && !protocolInvalid && !toolBudgetStopped) {
          const assistant = lastAssistant(sessionMessages);
          if (!assistant || assistant.stopReason !== "error") break;
          if (isContextOverflow(assistant, model.contextWindow)) {
            if (overflowCompacts >= SESSION_OVERFLOW_COMPACT_MAX) break;
            dropTrailingErrorAssistant(sessionMessages);
            const compacted = await compactAgentMessages({
              messages: sessionMessages,
              model,
              streamFn,
              signal: loopSignal,
            });
            if (!compacted) break;
            overflowCompacts += 1;
            emit({
              kind: "compaction",
              role: params.role,
              provider: params.primary.provider,
              model: params.primary.model,
              reason: "overflow",
            });
            sessionMessages.length = 0;
            sessionMessages.push(...compacted);
            try {
              const continued = continueLoop();
              void continued.catch(() => undefined);
              await runIdle(continued);
              loopError = undefined;
            } catch (error) {
              loopError = error;
              break;
            }
            continue;
          }
          if (!isRetryableAssistantError(assistant) || turnRetries >= SESSION_TURN_RETRY_MAX) {
            break;
          }
          dropTrailingErrorAssistant(sessionMessages);
          turnRetries += 1;
          emit({
            kind: "retry",
            role: params.role,
            checkpointId: opts.checkpointId,
            provider: params.primary.provider,
            model: params.primary.model,
            attempt: turnRetries,
            reason: "provider",
          });
          try {
            await abortableSleep(
              SESSION_TURN_RETRY_BASE_DELAY_MS * 2 ** (turnRetries - 1),
              loopSignal,
            );
            const continued = continueLoop();
            void continued.catch(() => undefined);
            await runIdle(continued);
            loopError = undefined;
          } catch (error) {
            loopError = error;
            break;
          }
        }

        if (abortPromise) {
          throw new AppError({
            code: "agent.session_aborted",
            message: "Agent runner session aborted",
          });
        }
        if (idleRejected) {
          throw new AppError({
            code: "pi.prompt_idle_timeout",
            message: `Provider prompt timeout: no activity for ${idleTimeoutMs}ms`,
          });
        }
        if (protocolInvalid) {
          throw new AppError({
            code: "provider.protocol_invalid",
            message: "Duplicate tool call id in one assistant message",
          });
        }
        if (loopSignal.aborted && !toolBudgetStopped) {
          throw new AppError({
            code: "agent.session_aborted",
            message: "Agent runner session aborted",
          });
        }
        if (terminalProviderError !== undefined && !toolBudgetStopped) {
          throw new AppError({
            code: "provider.request_failed",
            message: terminalProviderError,
          });
        }
        if (loopError !== undefined && !toolBudgetStopped) {
          throw toAppError(loopError, { code: "provider.request_failed" });
        }
        const promptMeta = promptMetadataFromText(prompt);
        const durationMs = sendStartedAt !== undefined ? Date.now() - sendStartedAt : undefined;
        emit({
          kind: "completion",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: params.primary.provider,
          model: params.primary.model,
          ok: true,
          ...(durationMs != null ? { durationMs } : {}),
          ...(aggregatedUsage != null
            ? {
                inputTokens: aggregatedUsage.inputTokens,
                outputTokens: aggregatedUsage.outputTokens,
              }
            : {}),
        });
        return aggregatedUsage
          ? { text: finalText, prompt: promptMeta, usage: aggregatedUsage }
          : { text: finalText, prompt: promptMeta };
      } catch (error) {
        const durationMs = sendStartedAt !== undefined ? Date.now() - sendStartedAt : undefined;
        emit({
          kind: "failure",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: params.primary.provider,
          model: params.primary.model,
          ok: false,
          failureCode: error instanceof AppError ? error.code : "runtime.session_send_failed",
          ...(durationMs != null ? { durationMs } : {}),
          ...(aggregatedUsage != null
            ? {
                inputTokens: aggregatedUsage.inputTokens,
                outputTokens: aggregatedUsage.outputTokens,
              }
            : {}),
        });
        throw error;
      } finally {
        if (sendStartedAt !== undefined) {
          try {
            recordReviewMetric({
              kind: "session_send_span",
              sendMs: Date.now() - sendStartedAt,
            });
          } catch {
            // metrics are best-effort
          }
        }
        if (idleCheckHandle) clearInterval(idleCheckHandle);
      }
    },
    abort,
    async dispose() {
      sessionAbort.abort();
    },
    getStructuredState: () => structuredState,
    setStructuredState(state) {
      structuredState = state;
    },
  };

  return piSession;
}
