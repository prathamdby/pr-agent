import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineExtension,
  defineTool,
  type ConversationOwnership,
  type SettledSubmissionRecord,
  type Submission,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { contentText, type Tool as PiTool } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import { AppError } from "../../../errors/appError.ts";
import { isRecord } from "../../../util/typeGuards.ts";
import type { EvidenceLedger } from "../../../review/findings/evidenceLedger.ts";
import { creditVisibleReads } from "./evidenceMemo.ts";
import { providerSessionIdInit } from "./providerRouting.ts";
import { promptMetadataFromText, type TurnEnd } from "../../providers/usageMetadata.ts";
import { resolveThinkingLevel } from "../thinkingPolicy.ts";
import type { AgentRunnerToolExecutor, AgentToolCallContext } from "../../providers/interface.ts";
import type { PiSessionCreateParams, PiSessionSendOptions } from "../types.ts";
import type { DurableRuntime } from "./runtime.ts";
import { createSessionTrace } from "../sessionTrace.ts";
import {
  contextForToolCall,
  beginSend,
  maxTurnsForSend,
  dropSessionState,
  registerSessionState,
  resetSendUsage,
  type DurableSessionState,
} from "./sessionState.ts";

export type DurableToolMeta = {
  readonly callers?: readonly ("model" | "tools")[];
  readonly replay?: "safe" | "unsafe";
};

export type DurablePiSessionParams = PiSessionCreateParams & {
  readonly runtime: DurableRuntime;
  readonly ownership?: ConversationOwnership;
  readonly providerSessionId?: string;
  readonly toolMeta?: Readonly<Record<string, DurableToolMeta>>;
  readonly codemode?: boolean;
};

export function creditBoundEvidence(state: DurableSessionState, ledger: EvidenceLedger) {
  creditVisibleReads(state.evidence.bound, ledger);
}

function sessionAbortedError() {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({
      domain: "agent",
      kind: "session_aborted",
      message: "The agent session was aborted.",
      context: {},
    }),
  );
}

function toolResultToText(result: unknown) {
  if (result === undefined) return ((pinnedReturn: string) => pinnedReturn)("");
  return ((pinnedReturn: string) => pinnedReturn)(
    typeof result === "string" ? result : JSON.stringify(result),
  );
}

function acceptedTerminalResult(result: unknown) {
  if (!isRecord(result)) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(result.accepted === true || result.ok === true);
}

export function toDurableTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
  state: () => DurableSessionState,
  meta?: DurableToolMeta,
) {
  const registration: ToolRegistration = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(meta?.callers !== undefined ? { callers: meta.callers } : {}),
    ...(meta?.replay !== undefined ? { replay: meta.replay } : {}),
    async execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
      const session = state();
      if (executor === undefined) {
        return {
          output: [{ type: "text", text: `Tool ${tool.name} has no executor.` }],
          isError: true,
        };
      }
      if (session.refreshBeforeTool !== undefined) {
        await session.refreshBeforeTool(tool.name);
      }
      const signal = context.abortSignal ?? session.hostSignal ?? new AbortController().signal;
      const ctx: AgentToolCallContext = contextForToolCall(session, api, signal);
      session.eventSink({
        kind: "tool",
        role: session.role,
        provider: session.provider,
        model: session.model,
        toolName: tool.name,
        ...(session.currentSend !== undefined ? { phase: session.currentSend.opts.phase } : {}),
      });
      const result = await executor(args, ctx);
      const text = toolResultToText(result);
      const resultState = sessionStateSnapshot(session);
      if (resultState !== undefined && tool.name === resultState.opts.reservedTerminalTool) {
        if (acceptedTerminalResult(result)) resultState.reservedFired = true;
      }
      session.eventSink({
        kind: "tool",
        role: session.role,
        provider: session.provider,
        model: session.model,
        toolName: tool.name,
        ok: true,
        ...(session.currentSend !== undefined ? { phase: session.currentSend.opts.phase } : {}),
      });
      return {
        output: [{ type: "text", text }],
        ...(acceptedTerminalResult(result) &&
        tool.name === session.currentSend?.opts.reservedTerminalTool
          ? { control: { terminate: true } }
          : {}),
      };
    },
  };
  return ((pinnedReturn: ToolRegistration) => pinnedReturn)(
    defineTool(registration) as ToolRegistration,
  );
}

function sessionStateSnapshot(state: DurableSessionState) {
  return ((pinnedReturn: DurableSessionState["currentSend"]) => pinnedReturn)(state.currentSend);
}

function mapSettlement(
  settled: SettledSubmissionRecord,
  state: DurableSessionState,
  currentSend: NonNullable<DurableSessionState["currentSend"]>,
) {
  if (currentSend.reservedFired) {
    return ((pinnedReturn: { text: string; end: TurnEnd }) => pinnedReturn)({
      text: "",
      end: "completed",
    });
  }
  if (settled.status === "unanswered") {
    if (settled.reason === "aborted" || settled.reason === "cancelled") {
      throw sessionAbortedError();
    }
    if (settled.reason === "turn_limit" || currentSend.stopped) {
      return ((pinnedReturn: { text: string; end: TurnEnd }) => pinnedReturn)({
        text: "",
        end: "tool_budget",
      });
    }
    throw new AppError({
      domain: "provider",
      kind: "request_failed",
      message: `The agent run ended unanswered: ${settled.reason}.`,
      context: { reason: settled.reason, detail: settled.detail ?? null },
    });
  }
  return ((pinnedReturn: { text: string; end: TurnEnd }) => pinnedReturn)({
    text: "",
    end: currentSend.stopped ? "tool_budget" : "completed",
  });
}

export async function createDurablePiSession(params: DurablePiSessionParams) {
  const { runtime } = params;
  const sessionExtensionName = `session-${randomUUID()}`;
  const state: DurableSessionState = {
    role: params.role,
    provider: params.primary.provider,
    model: params.primary.model,
    ...(params.systemPromptSharedHead !== undefined
      ? { systemPromptSharedHead: params.systemPromptSharedHead }
      : {}),
    systemPrompt: params.systemPrompt,
    toolDefinitions: params.tools,
    eventSink: params.eventSink,
    executors: params.executors,
    ...(params.refreshBeforeTool !== undefined
      ? { refreshBeforeTool: params.refreshBeforeTool }
      : {}),
    ...(params.hostSignal !== undefined ? { hostSignal: params.hostSignal } : {}),
    sendSeq: 0,
    aborted: false,
    evidence: {
      attempts: new Map(),
      visible: [],
      bound: [],
      credited: new Set(),
      reconLines: [],
      spillRoots: new Set(),
      spillBytes: 0,
      spillExpired: false,
    },
  };

  const tools = params.tools.map((tool) =>
    toDurableTool(tool, params.executors[tool.name], () => state, params.toolMeta?.[tool.name]),
  );
  const sessionExtension = defineExtension({
    name: sessionExtensionName,
    tools: [...tools, ...(params.durableTools ?? [])],
  });
  runtime.registry.install(sessionExtension);

  const conversation = await runtime.handle.harness.createConversation(
    {
      ownership: params.ownership ?? { kind: "ownerless" },
      agent: {
        model: { provider: params.primary.provider, modelId: params.primary.model },
        extensions: {
          add: [
            sessionExtension,
            ...(params.codemode === false ? [] : [runtime.codemodeExtension]),
          ],
        },
        instructions: params.systemPrompt,
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(!params.compactionPolicy.enabled ? { compaction: { enabled: false } } : {}),
      },
      ...(params.providerSessionId !== undefined
        ? {
            init: providerSessionIdInit(params.providerSessionId),
          }
        : {}),
    },
    BACKGROUND_CONTEXT,
  );
  registerSessionState(conversation.id, state);
  const traceModel = runtime.models.models.getModel(params.primary.provider, params.primary.model);
  if (traceModel !== undefined) {
    state.trace = createSessionTrace(
      params,
      traceModel,
      `${conversation.id}:${randomUUID()}`,
      () => state.currentSend?.assistantIndex ?? 0,
    );
    const credential = await runtime.models.credentials.read(params.primary.provider);
    if (credential !== undefined && credential.type === "api_key") {
      state.trace.addSecret(credential.key);
    }
  }
  if (params.systemPromptSharedHead !== undefined) {
    runtime.sharedHeadByConversation.set(conversation.id, params.systemPromptSharedHead);
  }

  let sendAbort: AbortController | undefined;
  const abortOnce = async (reason: string) => {
    state.eventSink({
      kind: "cancellation",
      role: state.role,
      provider: state.provider,
      model: state.model,
      reason,
    });
    await conversation.abort(BACKGROUND_CONTEXT).catch(() => {});
  };

  const send = async (prompt: string, opts: PiSessionSendOptions) => {
    if (state.aborted) throw sessionAbortedError();
    const thinkingLevel = resolveThinkingLevel({
      policy: params.thinkingPolicy,
      phase: opts.phase,
    });
    await conversation.configure(
      {
        thinkingLevel,
        maxTurns: maxTurnsForSend(opts),
      },
      BACKGROUND_CONTEXT,
    );
    resetSendUsage(state);
    state.currentSend = beginSend(opts);
    const sendState = state.currentSend;
    state.eventSink({
      kind: "turn",
      role: params.role,
      phase: opts.phase,
      checkpointId: opts.checkpointId,
      provider: params.primary.provider,
      model: params.primary.model,
    });

    state.trace?.beginSend(opts);
    const abortController = new AbortController();
    sendAbort = abortController;
    if (state.aborted) abortController.abort(sessionAbortedError());
    const deadlineMs = opts.deadlineMs;
    let watchdog: NodeJS.Timeout | undefined;
    if (deadlineMs !== undefined && deadlineMs > 0) {
      watchdog = setInterval(
        () => {
          if (Date.now() - sendState.lastActivityAt >= deadlineMs) {
            abortController.abort(
              new AppError({
                domain: "runtime",
                kind: "session_deadline_exceeded",
                message: `The send exceeded its ${deadlineMs}ms deadline.`,
                context: { deadlineMs },
              }),
            );
          }
        },
        Math.min(1000, deadlineMs),
      );
      watchdog.unref();
    }
    const onHostAbort = () => abortController.abort(params.hostSignal?.reason);
    params.hostSignal?.addEventListener("abort", onHostAbort, { once: true });
    const onDeadlineAbort = () => {
      void abortOnce(
        abortController.signal.reason instanceof AppError &&
          abortController.signal.reason.kind === "session_deadline_exceeded"
          ? "deadline"
          : "host_signal",
      );
    };
    abortController.signal.addEventListener("abort", onDeadlineAbort, { once: true });

    const requestId = `send-${params.role}-${++state.sendSeq}`;
    const startedAt = Date.now();
    try {
      const submission: Submission = await conversation.submit(
        {
          type: "input",
          content: prompt,
          requestId,
        },
        BACKGROUND_CONTEXT,
      );
      const settled = await submission.wait(
        withAbortSignal(abortController.signal, BACKGROUND_CONTEXT),
      );
      if (state.aborted) throw sessionAbortedError();
      const mapped = mapSettlement(settled, state, sendState);
      const answerEntry =
        settled.status === "done" && settled.answer !== undefined && !state.aborted
          ? await conversation.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              BACKGROUND_CONTEXT,
            )
          : undefined;
      const answerMessage = answerEntry?.model?.[0];
      const text =
        answerMessage !== undefined && answerMessage.role === "assistant"
          ? contentText(answerMessage.content)
          : "";
      const end: TurnEnd =
        answerMessage !== undefined &&
        answerMessage.role === "assistant" &&
        answerMessage.stopReason === "length" &&
        !sendState.reservedFired
          ? "output_limit"
          : mapped.end;
      state.trace?.endSend(end);
      state.eventSink({
        kind: "completion",
        ok: true,
        end,
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: params.primary.provider,
        model: params.primary.model,
        durationMs: Date.now() - startedAt,
        ...(state.usage?.inputTokens !== undefined ? { inputTokens: state.usage.inputTokens } : {}),
        ...(state.usage?.outputTokens !== undefined
          ? { outputTokens: state.usage.outputTokens }
          : {}),
        ...(state.usage?.cacheReadTokens !== undefined
          ? { cacheReadTokens: state.usage.cacheReadTokens }
          : {}),
        ...(state.usage?.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: state.usage.cacheWriteTokens }
          : {}),
        ...(state.usage?.reasoningTokens !== undefined
          ? { reasoningTokens: state.usage.reasoningTokens }
          : {}),
        ...(state.usage?.totalTokens !== undefined ? { totalTokens: state.usage.totalTokens } : {}),
      });
      return {
        text,
        end,
        ...(state.usage !== undefined ? { usage: state.usage } : {}),
        prompt: promptMetadataFromText(prompt),
      };
    } catch (error) {
      if (error instanceof AppError && error.kind === "session_aborted") {
        state.eventSink({
          kind: "cancellation",
          role: params.role,
          provider: params.primary.provider,
          model: params.primary.model,
          reason: "aborted",
        });
        throw error;
      }
      if (abortController.signal.aborted) {
        state.trace?.endSend(
          "failed",
          abortController.signal.reason instanceof AppError
            ? abortController.signal.reason.kind
            : "session_aborted",
        );
        state.eventSink({
          kind: "cancellation",
          role: params.role,
          provider: params.primary.provider,
          model: params.primary.model,
          reason:
            abortController.signal.reason instanceof AppError
              ? abortController.signal.reason.kind
              : "host_signal",
        });
        throw sessionAbortedError();
      }
      state.trace?.endSend(
        "failed",
        error instanceof AppError ? error.kind : "request_failed",
        error instanceof Error ? error.message : undefined,
      );
      state.eventSink({
        kind: "failure",
        ok: false,
        role: params.role,
        phase: opts.phase,
        checkpointId: opts.checkpointId,
        provider: params.primary.provider,
        model: params.primary.model,
        failureCode: error instanceof AppError ? error.kind : "request_failed",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (watchdog !== undefined) clearInterval(watchdog);
      params.hostSignal?.removeEventListener("abort", onHostAbort);
      abortController.signal.removeEventListener("abort", onDeadlineAbort);
      if (sendAbort === abortController) sendAbort = undefined;
      state.currentSend = undefined;
    }
  };

  return {
    role: params.role,
    primary: params.primary,
    send,
    abort: async () => {
      state.aborted = true;
      sendAbort?.abort(sessionAbortedError());
      await abortOnce("abort");
    },
    creditEvidence: (ledger: EvidenceLedger) => creditBoundEvidence(state, ledger),
    dispose: async () => {
      state.aborted = true;
      state.trace?.dispose();
      await conversation.abort(BACKGROUND_CONTEXT).catch(() => {});
      dropSessionState(conversation.id);
      runtime.sharedHeadByConversation.delete(conversation.id);
      runtime.registry.uninstall(sessionExtension);
    },
  };
}
