import { randomUUID } from "node:crypto";
import {
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { AppError, toAppError } from "../../errors/appError.js";
import type { AppErrorCode } from "../../errors/appErrorCodes.js";
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
  type TurnEnd,
} from "../providers/usageMetadata.js";
import { toCoreTools } from "./coreTools.js";
import { createSanitizedEventSink } from "./lifecycleSanitizer.js";
import { cacheIdentityFromAssignment, sessionCacheIdFromIdentity } from "./promptCachePolicy.js";
import { createSessionModels } from "./sessionModels.js";
import { createSessionStreamFn } from "./sessionStream.js";
import { createSessionTrace } from "./sessionTrace.js";
import { observeTrace } from "../../traces/recorder.js";
import { resolveThinkingLevel } from "./thinkingPolicy.js";
import { createSendActivity } from "./sendActivity.js";
import { createTurnToolBudget } from "./turnToolBudget.js";
import { createSessionCompaction } from "./sessionCompaction.js";
import { lastAssistant, runSessionTurn } from "./sessionTurnLoop.js";
import type { PiSession, PiSessionCreateParams } from "./types.js";

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
    // System messages carry the session prompt (and later tool declarations)
    // since pi-agent-core moved the prompt out of AgentContext into the transcript.
    if (
      message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult"
    ) {
      converted.push(message);
    }
  }
  return converted;
}

export async function createPiSessionImpl(params: PiSessionCreateParams): Promise<PiSession> {
  const sessionId = randomUUID();
  let traceSpanId: string | undefined;
  const emitForGeneration = (generationId?: string) =>
    createSanitizedEventSink((event) => {
      // Correlation is runtime-owned and added after the content allowlist.
      try {
        params.eventSink({
          ...event,
          sessionId,
          ...(traceSpanId ? { traceSpanId } : {}),
          ...(generationId != null ? { generationId } : {}),
          ...(params.specialistId != null ? { specialistId: params.specialistId } : {}),
        });
      } catch {
        // Observers cannot fail or retry an agent send.
      }
    });
  const emitSession = emitForGeneration();
  const sessionAbort = new AbortController();
  // pi-agent-core no longer takes a separate systemPrompt on AgentContext: the
  // prompt travels as the leading system message of the transcript instead.
  const sessionMessages: AgentMessage[] = [
    { role: "system", content: params.systemPrompt, timestamp: Date.now() },
  ];
  const sessionCacheId = sessionCacheIdFromIdentity(
    cacheIdentityFromAssignment(params.role, params.primary, params.specialistId),
  );

  const { models } = await createSessionModels(params.cfg);
  const model = models.getModel(params.primary.provider, params.primary.model);
  if (!model) {
    throw new AppError({
      domain: "provider",
      kind: "model_not_found",
      message: params.cfg.models.jsonPath
        ? `Model not found: ${params.primary.provider}/${params.primary.model} (models.json: ${params.cfg.models.jsonPath})`
        : `Model not found: ${params.primary.provider}/${params.primary.model}`,
      context: {
        piProvider: params.primary.provider,
        piModel: params.primary.model,
        ...(params.cfg.models.jsonPath ? { modelsJsonPath: params.cfg.models.jsonPath } : {}),
      },
    });
  }

  const { streamFn, getAttempts } = createSessionStreamFn(models, {
    cacheRetention: params.promptCachePolicy.retention,
    sessionId: sessionCacheId,
    timeoutMs: params.cfg.provider.promptTimeoutMs,
    maxRetries: params.cfg.provider.retryMax,
    maxRetryDelayMs: params.cfg.provider.maxRetryDelayMs,
  });
  const trace = observeTrace(() => createSessionTrace(params, model, sessionId, getAttempts));
  const tools = toCoreTools(
    params.tools,
    params.executors,
    params.hostSignal,
    params.refreshBeforeTool,
    (id, event) => {
      observeTrace(() => trace?.toolMetadata(id, event));
    },
  );

  let abortPromise: Promise<void> | undefined;
  const abort = (): Promise<void> => {
    abortPromise ??= (async () => {
      sessionAbort.abort();
      emitSession({
        kind: "cancellation",
        role: params.role,
        provider: model.provider,
        model: model.id,
        reason: "abort",
      });
    })();
    return abortPromise;
  };

  const piSession: PiSession = {
    role: params.role,
    primary: params.primary,
    async send(prompt, opts) {
      traceSpanId = undefined;
      observeTrace(() => trace?.beginSend(opts));
      if (abortPromise) {
        throw new AppError({
          domain: "agent",
          kind: "session_aborted",
          message: "Agent runner session aborted",
        });
      }
      const emit = emitForGeneration(randomUUID());
      const sendAbort = new AbortController();
      const loopSignal = combineAbortSignals([
        sessionAbort.signal,
        sendAbort.signal,
        params.hostSignal,
      ]);
      const phaseRef = { current: opts.phase };
      let protocolInvalid = false;
      const budget = createTurnToolBudget(opts);
      let finalText = "";
      let terminalProviderError: string | undefined;
      let aggregatedUsage: ReturnType<typeof exactUsageFromProviderUsage> | undefined;
      const activity = createSendActivity(
        opts.deadlineMs ?? params.cfg.provider.promptTimeoutMs,
        sendAbort,
      );
      const compaction = createSessionCompaction(params.compactionPolicy, {
        model,
        streamFn,
        signal: loopSignal,
        onCompaction: (reason) =>
          emit({
            kind: "compaction",
            role: params.role,
            provider: model.provider,
            model: model.id,
            reason,
          }),
        trace,
      });

      const thinking = resolveThinkingLevel({
        policy: params.thinkingPolicy,
        phase: opts.phase,
        modelSupportedLevels: getSupportedThinkingLevels(model),
      });
      const context: AgentContext = {
        messages: sessionMessages,
        tools,
      };
      const config: AgentLoopConfig = {
        model,
        convertToLlm,
        getApiKey: async (provider) => {
          try {
            const auth = await models.getAuth(provider);
            observeTrace(() => trace?.addSecret(auth?.auth.apiKey));
            return auth?.auth.apiKey;
          } catch {
            return undefined;
          }
        },
        cacheRetention: params.promptCachePolicy.retention,
        sessionId: sessionCacheId,
        timeoutMs: params.cfg.provider.promptTimeoutMs,
        maxRetries: params.cfg.provider.retryMax,
        maxRetryDelayMs: params.cfg.provider.maxRetryDelayMs,
        ...(thinking === "off" ? {} : { reasoning: thinking }),
        finishTurn: budget.finishTurn,
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
          return budget.beforeToolCall(toolCall.name);
        },
        ...(compaction.prepareNextTurn ? { prepareNextTurn: compaction.prepareNextTurn } : {}),
      };

      const handleEvent = (event: AgentEvent) => {
        observeTrace(() => trace?.event(event));
        if (
          event.type === "message_update" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end" ||
          event.type === "turn_end"
        ) {
          activity.markActivity();
        }
        if (event.type === "tool_execution_start") {
          emit({
            kind: "tool",
            role: params.role,
            phase: opts.phase,
            toolName: event.toolName,
            checkpointId: opts.checkpointId,
            provider: model.provider,
            model: model.id,
          });
        }
        if (event.type !== "turn_end") return;
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
            const turnUsage = exactUsageFromProviderUsage(assistant.usage);
            aggregatedUsage = mergeExactUsage(aggregatedUsage, turnUsage);
            emit({
              kind: "usage",
              role: params.role,
              phase: opts.phase,
              provider: model.provider,
              model: model.id,
              ...(turnUsage?.inputTokens != null ? { inputTokens: turnUsage.inputTokens } : {}),
              ...(turnUsage?.outputTokens != null ? { outputTokens: turnUsage.outputTokens } : {}),
              ...(turnUsage?.cacheReadTokens != null
                ? { cacheReadTokens: turnUsage.cacheReadTokens }
                : {}),
              ...(turnUsage?.cacheWriteTokens != null
                ? { cacheWriteTokens: turnUsage.cacheWriteTokens }
                : {}),
              ...(turnUsage?.cacheWrite1hTokens != null
                ? { cacheWrite1hTokens: turnUsage.cacheWrite1hTokens }
                : {}),
              ...(turnUsage?.totalTokens != null ? { totalTokens: turnUsage.totalTokens } : {}),
            });
          }
        }
        if (event.toolResults.length === 0) finalText = assistantMessageText(event.message);
        budget.observeTurn(event.toolResults);
      };

      emit({
        kind: "turn",
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: model.provider,
        model: model.id,
      });

      let sendStartedAt: number | undefined;
      try {
        sendStartedAt = Date.now();
        const { loopError } = await runSessionTurn(prompt, {
          context,
          config,
          streamFn,
          signal: loopSignal,
          handleEvent,
          activity,
          compaction,
          shouldContinue: () =>
            !abortPromise && !activity.rejected && !protocolInvalid && !budget.stopped,
          onRetry: (attempt) =>
            emit({
              kind: "retry",
              role: params.role,
              checkpointId: opts.checkpointId,
              provider: model.provider,
              model: model.id,
              attempt,
              reason: "provider",
            }),
        });

        if (abortPromise) {
          throw new AppError({
            domain: "agent",
            kind: "session_aborted",
            message: "Agent runner session aborted",
          });
        }
        activity.assertNotTimedOut();
        if (protocolInvalid) {
          throw new AppError({
            domain: "provider",
            kind: "protocol_invalid",
            message: "Duplicate tool call id in one assistant message",
          });
        }
        if (loopSignal.aborted && !budget.stopped) {
          throw new AppError({
            domain: "agent",
            kind: "session_aborted",
            message: "Agent runner session aborted",
          });
        }
        if (terminalProviderError !== undefined && !budget.stopped) {
          throw new AppError({
            domain: "provider",
            kind: "request_failed",
            message: terminalProviderError,
          });
        }
        if (loopError !== undefined && !budget.stopped) {
          throw toAppError(loopError, { domain: "provider", kind: "request_failed" });
        }
        const promptMeta = promptMetadataFromText(prompt);
        const durationMs = sendStartedAt !== undefined ? Date.now() - sendStartedAt : undefined;
        const end: TurnEnd = budget.stopped
          ? "tool_budget"
          : lastAssistant(sessionMessages)?.stopReason === "length"
            ? "output_limit"
            : "completed";
        traceSpanId = observeTrace(() => trace?.endSend(end));
        emit({
          kind: "completion",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: model.provider,
          model: model.id,
          ok: true,
          end,
          ...(durationMs != null ? { durationMs } : {}),
          ...(aggregatedUsage != null
            ? {
                inputTokens: aggregatedUsage.inputTokens,
                outputTokens: aggregatedUsage.outputTokens,
                cacheReadTokens: aggregatedUsage.cacheReadTokens,
                cacheWriteTokens: aggregatedUsage.cacheWriteTokens,
                cacheWrite1hTokens: aggregatedUsage.cacheWrite1hTokens,
                totalTokens: aggregatedUsage.totalTokens,
              }
            : {}),
        });
        return aggregatedUsage
          ? { text: finalText, end, prompt: promptMeta, usage: aggregatedUsage }
          : { text: finalText, end, prompt: promptMeta };
      } catch (error) {
        traceSpanId = observeTrace(() =>
          trace?.endSend(
            "failed",
            error instanceof AppError ? error.code : "runtime.session_send_failed",
          ),
        );
        const durationMs = sendStartedAt !== undefined ? Date.now() - sendStartedAt : undefined;
        emit({
          kind: "failure",
          role: params.role,
          phase: opts.phase,
          checkpointId: opts.checkpointId,
          provider: model.provider,
          model: model.id,
          ok: false,
          failureCode:
            error instanceof AppError
              ? error.code
              : ("runtime.session_send_failed" satisfies AppErrorCode),
          ...(durationMs != null ? { durationMs } : {}),
          ...(aggregatedUsage != null
            ? {
                inputTokens: aggregatedUsage.inputTokens,
                outputTokens: aggregatedUsage.outputTokens,
                cacheReadTokens: aggregatedUsage.cacheReadTokens,
                cacheWriteTokens: aggregatedUsage.cacheWriteTokens,
                cacheWrite1hTokens: aggregatedUsage.cacheWrite1hTokens,
                totalTokens: aggregatedUsage.totalTokens,
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
        activity.dispose();
      }
    },
    abort,
    async dispose() {
      sessionAbort.abort();
      observeTrace(() => trace?.dispose());
    },
  };

  return piSession;
}
