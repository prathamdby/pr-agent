import {
  configure,
  defineExtension,
  SubmissionSettled,
  type ConversationId,
  type Extension,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "../types.ts";
import type { Context } from "@earendil-works/chord/context";
import type { ReviewChildRequest } from "../../../review/orchestrator/orchestratorRun.ts";
import { providerSessionIdInit } from "./providerRouting.ts";
import type { VisibleRead } from "./sessionState.ts";
import { bindReviewJournal } from "./reviewTurnJournal.ts";
import type { DurableRuntime } from "./runtime.ts";
import { toDurableTool } from "./session.ts";
import {
  registerSessionState,
  dropSessionState,
  type DurableSessionState,
} from "./sessionState.ts";

type ReviewChildSpec = ReviewChildRequest & { extensionName: string };

export type ReviewChildLive = {
  readonly extension: Extension;
  readonly state: DurableSessionState;
};

type AnyTaskRuntime = TaskRuntime<unknown, { readonly phase: string }, unknown, object>;

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
    eventSink: () => undefined,
    executors: spec.tools.executors,
    sendSeq: 0,
    aborted: false,
    evidence: {
      attempts: new Map(),
      visible: [],
      bound: [],
      credited: new Set(),
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

export async function bindReviewChild(
  runtime: DurableRuntime,
  conversationId: ConversationId,
  live: ReviewChildLive,
  applyEvidence: (reads: readonly VisibleRead[]) => void,
  sharedHead?: string,
) {
  await bindReviewJournal(runtime.handle.harness, conversationId, live.state, applyEvidence);
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
  codemode: Extension,
  spec: ReviewChildRequest,
  live: ReviewChildLive,
  thinkingLevel: ThinkingLevel,
) {
  const record = await tx.createConversation({
    ownership: { kind: "task", taskId: ownerTaskId },
  });
  await configure(tx, record.id, {
    model: { provider: spec.provider, modelId: spec.model },
    thinkingLevel,
    extensions: { add: [codemode, live.extension] },
    instructions: spec.systemPrompt,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...(spec.compaction ? {} : { compaction: { enabled: false } }),
  });
  if (spec.providerSessionId !== undefined) {
    await providerSessionIdInit(spec.providerSessionId)(tx, record.id);
  }
  return ((pinnedReturn: ConversationId) => pinnedReturn)(record.id);
}

export function settledTurnKey(role: string, turnNo: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`${role}:${turnNo}`);
}

export function settledTurnSignalKey(role: string, turnNo: number) {
  return SubmissionSettled.key(settledTurnKey(role, turnNo));
}

export async function abortReviewChild(
  taskRuntime: AnyTaskRuntime,
  context: Context,
  conversationId: ConversationId,
) {
  const conversation = await taskRuntime.conversation(conversationId, context);
  await conversation?.abort(context).catch(() => undefined);
}
