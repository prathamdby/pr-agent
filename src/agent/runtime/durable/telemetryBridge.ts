import {
  GenerationTask,
  hook,
  ToolTask,
  type Harness,
  type HookRegistration,
} from "@earendil-works/pi-durable";
import { exactUsageFromProviderUsage, mergeExactUsage } from "../../providers/usageMetadata.ts";
import { recordPromptCacheBreak } from "../../../review/run/reviewRunMetrics.ts";
import { createPromptCacheTracker } from "../promptCachePolicy.ts";
import { sessionStateFor, WarmupReleased } from "./sessionState.ts";

const TOOL_BUDGET_BLOCK =
  "The tool round budget for this turn is spent. Call the reserved submission tool now.";

export function createToolGateHooks() {
  const gate = hook(ToolTask, {
    beforeTool: async (call, api) => {
      const state = sessionStateFor(api.conversationId);
      const send = state?.currentSend;
      if (state === undefined || send === undefined) return undefined;
      send.lastActivityAt = Date.now();
      const name = call.name;
      if (name === send.opts.reservedTerminalTool) return undefined;
      const { taskId } = api;
      const alreadyAdmitted = call.parent !== undefined || send.countedCalls.has(taskId);
      const pastStop = send.opts.stopAtMs !== undefined && Date.now() >= send.opts.stopAtMs;
      const pastRounds =
        send.opts.maxToolRounds !== undefined && send.countedCalls.size >= send.opts.maxToolRounds;
      if (pastStop || (!alreadyAdmitted && pastRounds) || send.blockedCalls.has(taskId)) {
        send.stopped = true;
        if (!send.blockedCalls.has(taskId)) {
          send.blockedCalls.add(taskId);
          await state.journal?.charge(taskId, true);
        }
        return ((pinnedReturn: { block: string } | undefined) => pinnedReturn)({
          block: TOOL_BUDGET_BLOCK,
        });
      }
      if (alreadyAdmitted) return undefined;
      send.countedCalls.add(taskId);
      try {
        await state.journal?.charge(taskId, false);
      } catch {
        send.countedCalls.delete(taskId);
        return { block: "Cannot record this tool call against the turn budget." };
      }
      return undefined;
    },
    afterTool: async (call, result, api) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return undefined;
      const send = state.currentSend;
      if (send !== undefined) send.lastActivityAt = Date.now();
      state.eventSink({
        kind: "tool",
        role: state.role,
        provider: state.provider,
        model: state.model,
        toolName: call.name,
        ok: result.isError !== true,
        ...(send !== undefined ? { phase: send.opts.phase } : {}),
      });
      if (send !== undefined && send.blockedCalls.size >= 2 && result.isError === true) {
        return ((pinnedReturn: typeof result) => pinnedReturn)({
          ...result,
          control: { ...result.control, terminate: true },
        });
      }
      return undefined;
    },
  });
  return ((pinnedReturn: readonly HookRegistration[]) => pinnedReturn)([gate]);
}

export function createTelemetryHooks() {
  const telemetry = hook(GenerationTask, {
    beforeRequest: ({ messages }, api) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return undefined;
      if (state.promptCacheTracker === undefined) {
        const role = state.role;
        state.promptCacheTracker = createPromptCacheTracker({
          role,
          systemText: state.systemPrompt,
          tools: state.toolDefinitions,
          ...(state.systemPromptSharedHead !== undefined
            ? { sharedHead: state.systemPromptSharedHead }
            : {}),
          record: (observed) => recordPromptCacheBreak({ session: role, ...observed }),
        });
      }
      state.promptCacheTracker(messages);
      return undefined;
    },
    afterResponse: async (message, api) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return;
      const usage = exactUsageFromProviderUsage(message.usage);
      state.usage = mergeExactUsage(state.usage, usage);
      if (message.providerThinkingLevel !== undefined) state.effort = message.providerThinkingLevel;
      state.eventSink({
        kind: "usage",
        role: state.role,
        provider: state.provider,
        model: state.model,
        ...(state.currentSend !== undefined ? { phase: state.currentSend.opts.phase } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: usage.cacheWriteTokens }
          : {}),
        ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      });
    },
  });
  return ((pinnedReturn: readonly HookRegistration[]) => pinnedReturn)([telemetry]);
}

export function createWarmupReleaseHooks(harness: () => Harness) {
  const release = hook(GenerationTask, {
    afterResponse: async (_message, api, context) => {
      const state = sessionStateFor(api.conversationId);
      const target = state?.warmupRelease;
      if (state === undefined || target === undefined || target.sent) return;
      target.sent = true;
      try {
        await harness().signal(target.taskId, WarmupReleased, target.key, {}, context);
      } catch {
        target.sent = false;
      }
    },
  });
  return ((pinnedReturn: readonly HookRegistration[]) => pinnedReturn)([release]);
}
