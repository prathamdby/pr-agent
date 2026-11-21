import {
  configure,
  defineDoc,
  defineExtension,
  ProviderDoc,
  SubmissionSettled,
  type ContextView,
  type ConversationId,
  type Extension,
  type TaskId,
  type TaskRuntime,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "../types.ts";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { contentText, type Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../../providers/interface.ts";
import type { AgentLifecycleEvent, AgentSessionRole, PiSessionSendOptions } from "../types.ts";
import { isRecord } from "../../../util/typeGuards.ts";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  type EvidenceLedger,
} from "../../../review/findings/evidenceLedger.ts";
import { EvidenceBindingDoc } from "./evidenceMemo.ts";
import type { DurableRuntime } from "./runtime.ts";
import { toDurableTool, type DurableToolMeta } from "./session.ts";
import {
  registerSessionState,
  dropSessionState,
  type BoundEvidenceMemo,
  type DurableSessionState,
} from "./sessionState.ts";

export type ReviewChildTools = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly durableTools?: readonly ToolRegistration[];
  readonly toolMeta?: Readonly<Record<string, DurableToolMeta>>;
};

export type ReviewChildSpec = {
  readonly extensionName: string;
  readonly role: AgentSessionRole;
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly systemPromptSharedHead?: string;
  readonly headSha: string;
  readonly cwd?: string;
  readonly tools: ReviewChildTools;
  readonly reconEvidence?: DurableSessionState["evidence"]["reconLines"];
  readonly providerSessionId?: string;
  readonly compaction: boolean;
  readonly codemode: boolean;
  readonly eventSink?: (event: AgentLifecycleEvent) => void;
};

export type ReviewChildLive = {
  readonly extension: Extension;
  readonly state: DurableSessionState;
};

type AnyTaskRuntime = TaskRuntime<unknown, { readonly phase: string }, unknown, object>;

export const ReviewChildRoleDoc = defineDoc({
  kind: "pr.review_child_role",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ role: "" }),
  checkpointWhen: () => false,
});

export async function reviewChildConversations(taskRuntime: AnyTaskRuntime, context: Context) {
  const ids: ConversationId[] = [];
  await taskRuntime.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskRuntime.taskId }, 32);
    for (const record of page.items) ids.push(record.id);
    return undefined;
  }, context);
  const byRole = new Map<string, ConversationId>();
  for (const id of ids) {
    const doc = await taskRuntime.snapshot(ReviewChildRoleDoc, id, context);
    if (doc !== undefined && doc.role.length > 0) byRole.set(doc.role, id);
  }
  return byRole;
}

export function reviewExtensionName(attemptId: string, role: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`pr-review-${attemptId}-${role}`);
}

export function installReviewChild(runtime: DurableRuntime, spec: ReviewChildSpec) {
  const state: DurableSessionState = {
    role: spec.role,
    provider: spec.provider,
    model: spec.model,
    headSha: spec.headSha,
    ...(spec.systemPromptSharedHead !== undefined
      ? { systemPromptSharedHead: spec.systemPromptSharedHead }
      : {}),
    systemPrompt: spec.systemPrompt,
    toolDefinitions: spec.tools.piTools,
    eventSink: spec.eventSink ?? (() => undefined),
    executors: spec.tools.executors,
    sendSeq: 0,
    aborted: false,
    evidence: {
      attempts: new Map(),
      requestVisible: new Map(),
      bindings: [],
      reconLines: spec.reconEvidence ?? [],
      spillRoots: new Set(),
      spillBytes: 0,
      spillExpired: false,
    },
  };
  const tools = spec.tools.piTools.map((tool) =>
    toDurableTool(
      tool,
      spec.tools.executors[tool.name],
      () => state,
      spec.tools.toolMeta?.[tool.name],
    ),
  );
  const extension = defineExtension({
    name: spec.extensionName,
    tools: [...tools, ...(spec.tools.durableTools ?? [])],
  });
  runtime.registry.install(extension);
  return ((pinnedReturn: ReviewChildLive) => pinnedReturn)({ extension, state });
}

export function bindReviewChild(
  runtime: DurableRuntime,
  conversationId: ConversationId,
  live: ReviewChildLive,
  sharedHead?: string,
) {
  registerSessionState(conversationId, live.state);
  if (sharedHead !== undefined) runtime.sharedHeadByConversation.set(conversationId, sharedHead);
}

export function releaseReviewChild(
  runtime: DurableRuntime,
  conversationId: ConversationId | undefined,
  live: ReviewChildLive,
) {
  if (conversationId !== undefined) {
    dropSessionState(conversationId);
    runtime.sharedHeadByConversation.delete(conversationId);
  }
  runtime.registry.uninstall(live.extension);
}

export async function initReviewChild(
  tx: Tx,
  ownerTaskId: TaskId,
  role: string,
  spec: ReviewChildSpec,
  live: ReviewChildLive,
  thinkingLevel: ThinkingLevel,
) {
  const record = await tx.createConversation({
    ownership: { kind: "task", taskId: ownerTaskId },
  });
  await configure(tx, record.id, {
    model: { provider: spec.provider, modelId: spec.model },
    thinkingLevel,
    extensions: { add: [live.extension] },
    instructions: spec.systemPrompt,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...(spec.compaction ? {} : { compaction: { enabled: false } }),
  });
  if (spec.providerSessionId !== undefined) {
    const doc = await tx.doc(ProviderDoc, record.id);
    doc.sessionId = spec.providerSessionId;
  }
  const roleDoc = await tx.doc(ReviewChildRoleDoc, record.id);
  roleDoc.role = role;
  return ((pinnedReturn: ConversationId) => pinnedReturn)(record.id);
}

export async function submitReviewTurn(
  taskRuntime: AnyTaskRuntime,
  context: Context,
  params: {
    readonly conversationId: ConversationId;
    readonly live: ReviewChildLive;
    readonly requestId: string;
    readonly key: string;
    readonly prompt: string;
    readonly opts: PiSessionSendOptions;
    readonly thinkingLevel: ThinkingLevel;
    readonly steer?: boolean;
  },
) {
  const conversation = await taskRuntime.conversation(params.conversationId, context);
  if (conversation === undefined) throw new Error("review child conversation is missing");
  const maxTurns =
    params.opts.maxToolRounds !== undefined
      ? params.opts.maxToolRounds + 2 + (params.opts.reservedTerminalTool !== undefined ? 1 : 0)
      : null;
  if (params.steer !== true) {
    await taskRuntime.commit(async (tx) => {
      await configure(tx, params.conversationId, { maxTurns, thinkingLevel: params.thinkingLevel });
      return undefined;
    }, context);
  }
  params.live.state.currentSend = {
    opts: params.opts,
    rounds: 0,
    countedCalls: new Set(),
    budgetBlockedCalls: 0,
    stopped: false,
    reservedFired: false,
    lastActivityAt: Date.now(),
    assistantIndex: 0,
  };
  await conversation.submit(
    {
      type: "input",
      content: params.prompt,
      requestId: params.requestId,
      notify: { taskId: taskRuntime.taskId, key: params.key },
      ...(params.steer === true ? { whenBusy: "steer" as const } : {}),
    },
    context,
  );
}

export type SettledReviewTurn =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly text: string; readonly stopReason: string | undefined }
  | { readonly status: "unanswered"; readonly reason: string };

export async function readSettledTurn(
  taskRuntime: AnyTaskRuntime,
  context: Context,
  params: {
    readonly key: string;
    readonly conversationId: ConversationId;
    readonly live?: ReviewChildLive;
  },
) {
  const signal = await taskRuntime.readSignal(SubmissionSettled, params.key, context);
  if (signal === undefined || !("value" in signal))
    return ((pinnedReturn: SettledReviewTurn) => pinnedReturn)({ status: "pending" });
  const settled = signal.value;
  const live = params.live;
  if (live !== undefined) {
    live.state.currentSend = undefined;
    const bindings: JsonValue[] = live.state.evidence.bindings.map(
      (binding) => JSON.parse(JSON.stringify(binding)) as JsonValue,
    );
    if (bindings.length > 0) {
      await taskRuntime.commit(async (tx) => {
        const doc = await tx.doc(EvidenceBindingDoc, params.conversationId);
        doc.bindings = bindings;
        return undefined;
      }, context);
    }
  }
  if (settled.status === "unanswered")
    return ((pinnedReturn: SettledReviewTurn) => pinnedReturn)({
      status: "unanswered",
      reason: settled.reason,
    });
  const entry = await taskRuntime.context(params.conversationId, context);
  const answer = entry.messages.toReversed().find((message) => message.role === "assistant");
  return ((pinnedReturn: SettledReviewTurn) => pinnedReturn)({
    status: "done",
    text: answer !== undefined && answer.role === "assistant" ? contentText(answer.content) : "",
    stopReason: answer !== undefined && answer.role === "assistant" ? answer.stopReason : undefined,
  });
}

export function settledTurnKey(role: string, turnNo: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`${role}:${turnNo}`);
}

export function settledTurnSignalKey(role: string, turnNo: number) {
  return SubmissionSettled.key(settledTurnKey(role, turnNo));
}

export type TranscriptToolCall = {
  readonly assistantOrdinal: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly resultText: string | undefined;
};

export function transcriptToolCalls(view: ContextView, toolName: string) {
  const results = new Map<string, string>();
  for (const message of view.messages) {
    if (message.role !== "toolResult") continue;
    const parts: string[] = [];
    for (const content of message.content) if (content.type === "text") parts.push(content.text);
    results.set(message.toolCallId, parts.join("\n"));
  }
  const calls: TranscriptToolCall[] = [];
  let assistantOrdinal = 0;
  for (const message of view.messages) {
    if (message.role !== "assistant") continue;
    assistantOrdinal += 1;
    for (const content of message.content) {
      if (content.type !== "toolCall" || content.name !== toolName) continue;
      calls.push({
        assistantOrdinal,
        name: content.name,
        args: isRecord(content.arguments) ? content.arguments : {},
        resultText: results.get(content.id),
      });
    }
  }
  return ((pinnedReturn: readonly TranscriptToolCall[]) => pinnedReturn)(calls);
}

export async function readEvidenceBindings(
  taskRuntime: AnyTaskRuntime,
  context: Context,
  conversationId: ConversationId,
) {
  const doc = await taskRuntime.snapshot(EvidenceBindingDoc, conversationId, context);
  const bindings: BoundEvidenceMemo[] = [];
  for (const raw of doc?.bindings ?? []) {
    if (!isRecord(raw) || typeof raw.assistantIndex !== "number" || !Array.isArray(raw.visible))
      continue;
    const visible: BoundEvidenceMemo["visible"][number][] = [];
    for (const entry of raw.visible) {
      if (
        !isRecord(entry) ||
        typeof entry.path !== "string" ||
        typeof entry.headSha !== "string" ||
        typeof entry.tool !== "string" ||
        typeof entry.contentHash !== "string" ||
        typeof entry.startLine !== "number" ||
        typeof entry.endLine !== "number" ||
        typeof entry.content !== "string" ||
        !Array.isArray(entry.lines)
      )
        continue;
      visible.push({
        path: entry.path,
        headSha: entry.headSha,
        tool: entry.tool,
        contentHash: entry.contentHash,
        startLine: entry.startLine,
        endLine: entry.endLine,
        content: entry.content,
        lines: entry.lines.filter((line): line is number => typeof line === "number"),
      });
    }
    bindings.push({ assistantIndex: raw.assistantIndex, visible });
  }
  return ((pinnedReturn: readonly BoundEvidenceMemo[]) => pinnedReturn)(bindings);
}

export function creditBindings(bindings: readonly BoundEvidenceMemo[], ledger: EvidenceLedger) {
  for (const binding of bindings) {
    for (const entry of binding.visible) {
      ledger.noteOpened(entry.path);
      const contentLines = entry.content.replace(/\r\n/g, "\n").split("\n");
      const sorted = [...new Set(entry.lines)].toSorted((a, b) => a - b);
      let rangeStart: number | undefined;
      let previous: number | undefined;
      const flush = () => {
        if (rangeStart === undefined || previous === undefined) return;
        const text = contentLines
          .slice(rangeStart - entry.startLine, previous - entry.startLine + 1)
          .join("\n");
        const contentHash = hashNormalizedLineText(text);
        ledger.record({
          path: entry.path,
          startLine: rangeStart,
          endLine: previous,
          contentHash,
          headSha: entry.headSha,
          tool: entry.tool,
          descriptor: {
            version: 1,
            kind: "file_range",
            path: normalizeEvidencePath(entry.path),
            startLine: rangeStart,
            endLine: previous,
            contentHash,
            headSha: entry.headSha,
          },
        });
      };
      for (const line of sorted) {
        if (previous !== undefined && line === previous + 1) {
          previous = line;
          continue;
        }
        flush();
        rangeStart = line;
        previous = line;
      }
      flush();
    }
  }
}

export async function abortReviewChild(
  taskRuntime: AnyTaskRuntime,
  context: Context,
  conversationId: ConversationId,
) {
  const conversation = await taskRuntime.conversation(conversationId, context);
  await conversation?.abort(context).catch(() => undefined);
}
