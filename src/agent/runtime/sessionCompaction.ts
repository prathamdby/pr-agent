import type { AgentLoopConfig, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { SESSION_OVERFLOW_COMPACT_MAX } from "../../settings/index.js";
import {
  compactAgentMessages,
  compactIfNeeded,
  dropTrailingErrorAssistant,
} from "./transcriptCompaction.js";
import type { CompactionPolicy } from "./types.js";

type SessionCompactionRuntime = {
  readonly model: AgentLoopConfig["model"];
  readonly streamFn: StreamFn;
  readonly signal: AbortSignal;
  readonly onCompaction: (reason: "window" | "overflow") => void;
};

/** Window compaction is role-controlled; overflow recovery has an independent cap. */
export function createSessionCompaction(policy: CompactionPolicy, rt: SessionCompactionRuntime) {
  let overflowCompacts = 0;
  const prepareNextTurn: NonNullable<AgentLoopConfig["prepareNextTurn"]> = async ({ context }) => {
    const compacted = await compactIfNeeded({
      messages: context.messages,
      model: rt.model,
      streamFn: rt.streamFn,
      signal: rt.signal,
    });
    if (!compacted) return undefined;
    rt.onCompaction("window");
    context.messages.length = 0;
    context.messages.push(...compacted);
    return { context };
  };
  return {
    prepareNextTurn: policy.enabled ? prepareNextTurn : undefined,
    async recoverOverflow(messages: AgentMessage[]): Promise<boolean> {
      if (overflowCompacts >= SESSION_OVERFLOW_COMPACT_MAX) return false;
      dropTrailingErrorAssistant(messages);
      const compacted = await compactAgentMessages({
        messages,
        model: rt.model,
        streamFn: rt.streamFn,
        signal: rt.signal,
      });
      if (!compacted) return false;
      overflowCompacts += 1;
      rt.onCompaction("overflow");
      messages.length = 0;
      messages.push(...compacted);
      return true;
    },
  };
}
