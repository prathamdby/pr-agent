import { GenerationTask, hook, ToolTask, type HookRegistration } from "@earendil-works/pi-durable";
import { exactUsageFromProviderUsage, mergeExactUsage } from "../../providers/usageMetadata.ts";
import { recordPromptCacheBreak } from "../../../review/run/reviewRunMetrics.ts";
import { createPromptCacheTracker } from "../promptCachePolicy.ts";
import { sessionStateFor } from "./sessionState.ts";

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
      const phaseDenial = state.phaseAllowedTools?.(send.opts.phase, name);
      if (phaseDenial !== undefined) {
        return ((pinnedReturn: { block: string } | undefined) => pinnedReturn)({
          block: phaseDenial,
        });
      }
      const pastStop = send.opts.stopAtMs !== undefined && Date.now() >= send.opts.stopAtMs;
      const pastRounds =
        send.opts.maxToolRounds !== undefined && send.rounds >= send.opts.maxToolRounds;
      if (pastStop || pastRounds) {
        send.stopped = true;
        send.budgetBlockedCalls += 1;
        return ((pinnedReturn: { block: string } | undefined) => pinnedReturn)({
          block: TOOL_BUDGET_BLOCK,
        });
      }
      if (call.parent === undefined && !send.countedCalls.has(call.id)) {
        send.countedCalls.add(call.id);
        send.rounds += 1;
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
      if (send !== undefined && send.budgetBlockedCalls >= 2 && result.isError === true) {
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
