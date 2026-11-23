import {
  CompactionTask,
  GenerationTask,
  ToolTask,
  hook,
  type ConversationId,
  type HookRegistration,
  type TaskId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { contentText, type Models } from "@earendil-works/pi-ai";
import type { HostCallOutcome } from "../../providers/interface.ts";
import { sessionStateFor } from "./sessionState.ts";

const pendingCompactions = new Set<ConversationId>();
const openHostCalls = new Map<TaskId, (outcome: HostCallOutcome) => void>();

function hostCallOutcome(result: ToolExecutionResult) {
  if (result.isError === true) {
    const errorKind = result.diagnostics?.find(
      (diagnostic) => diagnostic.severity === "error",
    )?.code;
    return ((pinnedReturn: HostCallOutcome) => pinnedReturn)({
      status: "error",
      errorKind: errorKind ?? "tool_error",
    });
  }
  const text = contentText(result.output ?? "");
  const output =
    text.length > 0
      ? text
      : result.structuredOutput === undefined
        ? ""
        : JSON.stringify(result.structuredOutput);
  return ((pinnedReturn: HostCallOutcome) => pinnedReturn)({
    status: "completed",
    output,
    outputBytes: Buffer.byteLength(output),
  });
}

export function createTraceHooks() {
  const toolSpans = hook(ToolTask, {
    beforeTool: (call, api) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return undefined;
      if (call.parent !== undefined) {
        const close = state.trace?.hostCall(call.parent.callId, call.name, call.arguments);
        if (close !== undefined) openHostCalls.set(api.taskId, close);
        return undefined;
      }
      state.trace?.event({
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      });
      return undefined;
    },
    afterTool: (call, result, api) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return undefined;
      if (call.parent !== undefined) {
        const close = openHostCalls.get(api.taskId);
        openHostCalls.delete(api.taskId);
        close?.(hostCallOutcome(result));
        return undefined;
      }
      state.trace?.event({
        type: "tool_execution_end",
        toolCallId: call.id,
        result,
        isError: result.isError === true,
      });
      return undefined;
    },
  });
  const requestBasis = hook(GenerationTask, {
    beforeRequest: ({ messages }, api) => {
      sessionStateFor(api.conversationId)?.trace?.compacted(messages);
      return undefined;
    },
  });
  const compaction = hook(CompactionTask, {
    beforeCompact: (_compaction, api) => {
      pendingCompactions.add(api.conversationId);
      return undefined;
    },
  });
  return ((pinnedReturn: readonly HookRegistration[]) => pinnedReturn)([
    toolSpans,
    requestBasis,
    compaction,
  ]);
}

function pendingCompactionConversation() {
  if (pendingCompactions.size !== 1)
    return ((pinnedReturn: ConversationId | undefined) => pinnedReturn)(undefined);
  for (const conversationId of pendingCompactions) {
    return ((pinnedReturn: ConversationId) => pinnedReturn)(conversationId);
  }
  return ((pinnedReturn: ConversationId | undefined) => pinnedReturn)(undefined);
}

export function observeCompactionRequests(models: Models) {
  const observed = Object.create(models) as Models;
  const completeSimple = models.completeSimple.bind(models);
  observed.completeSimple = async (model, context, options) => {
    const conversationId = pendingCompactionConversation();
    if (conversationId === undefined) {
      return completeSimple(model, context, options);
    }
    pendingCompactions.delete(conversationId);
    const state = sessionStateFor(conversationId);
    if (state === undefined) return completeSimple(model, context, options);
    const system = context.messages.find((message) => message.role === "system");
    const prompt = context.messages.findLast((message) => message.role === "user");
    state.trace?.beginCompaction(
      system === undefined ? "" : contentText(system.content),
      prompt === undefined ? "" : contentText(prompt.content),
    );
    try {
      const message = await completeSimple(model, context, options);
      state.trace?.endCompaction(message);
      return ((pinnedReturn: typeof message) => pinnedReturn)(message);
    } catch (error) {
      state.trace?.endCompaction(undefined);
      throw error;
    }
  };
  return ((pinnedReturn: Models) => pinnedReturn)(observed);
}
