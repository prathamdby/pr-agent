import { GenerationTask, defineDoc, hook, type HookRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Message } from "@earendil-works/pi-ai";
import { isRecord } from "../../../util/typeGuards.ts";
import type { EvidenceReadAttempt } from "./sessionState.ts";
import { sessionStateFor } from "./sessionState.ts";

const MISSING_RESULT_REASON = "missing_result";
const EVIDENCE_FENCE_RE = /^(\S[^\n]*):(\d+)-(\d+) sha256:([0-9a-f]{64})\n```\n([\s\S]*?)\n```/gm;

export const EvidenceBindingDoc = defineDoc({
  kind: "pr.evidence_bindings",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ bindings: [] as JsonValue[] }),
  checkpointWhen: () => true,
});

export type VisibleEvidenceLines = {
  readonly path: string;
  readonly headSha: string;
  readonly tool: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly number[];
  readonly content: string;
};

function toolResultText(message: Message) {
  if (message.role !== "toolResult")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const parts: string[] = [];
  for (const content of message.content) {
    if (content.type === "text") parts.push(content.text);
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    parts.length === 0 ? undefined : parts.join("\n"),
  );
}

function isMissingResultPlaceholder(message: Message) {
  if (message.role !== "toolResult" || message.details === undefined)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const details = message.details;
  return ((pinnedReturn: boolean) => pinnedReturn)(
    isRecord(details) && details.reason === MISSING_RESULT_REASON,
  );
}

function completeLineCount(text: string, allowEofLine: boolean) {
  if (text.length === 0) return ((pinnedReturn: number) => pinnedReturn)(0);
  const lines = text.split("\n");
  if (text.endsWith("\n")) return ((pinnedReturn: number) => pinnedReturn)(lines.length - 1);
  return ((pinnedReturn: number) => pinnedReturn)(lines.length - (allowEofLine ? 0 : 1));
}

function visibleSlice(text: string, attemptText: string) {
  const total = completeLineCount(attemptText, !attemptText.endsWith("\n"));
  if (text === attemptText) {
    return ((pinnedReturn: { head: boolean; count: number }) => pinnedReturn)({
      head: true,
      count: total,
    });
  }
  const eofLine = !attemptText.endsWith("\n");
  if (attemptText.startsWith(text)) {
    return ((pinnedReturn: { head: boolean; count: number }) => pinnedReturn)({
      head: true,
      count: Math.min(completeLineCount(text, eofLine), total),
    });
  }
  if (attemptText.endsWith(text)) {
    return ((pinnedReturn: { head: boolean; count: number }) => pinnedReturn)({
      head: false,
      count: Math.min(completeLineCount(text, eofLine), total),
    });
  }
  return ((pinnedReturn: { head: boolean; count: number }) => pinnedReturn)({
    head: true,
    count: 0,
  });
}

function creditedLines(attempt: EvidenceReadAttempt, candidateText: string) {
  const slice = visibleSlice(candidateText, attempt.content);
  if (slice.count === 0) return [];
  const window = slice.head
    ? attempt.lines.slice(0, slice.count)
    : attempt.lines.slice(-slice.count);
  return window.filter((line) => line > 0 && !attempt.clampedLines.includes(line));
}

function jsonField(text: string, field: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const value = parsed[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function pushVisible(
  visible: VisibleEvidenceLines[],
  attempt: EvidenceReadAttempt,
  lines: readonly number[],
) {
  if (lines.length === 0) return;
  visible.push({
    path: attempt.path,
    headSha: attempt.headSha,
    tool: attempt.tool,
    contentHash: attempt.contentHash,
    startLine: attempt.startLine,
    endLine: attempt.endLine,
    lines,
    content: attempt.content,
  });
}

function scanEmittedBlocks(
  text: string,
  attempts: ReadonlyMap<string, EvidenceReadAttempt>,
  visible: VisibleEvidenceLines[],
) {
  EVIDENCE_FENCE_RE.lastIndex = 0;
  for (
    let match = EVIDENCE_FENCE_RE.exec(text);
    match !== null;
    match = EVIDENCE_FENCE_RE.exec(text)
  ) {
    const [, rawPath, rawStart, rawEnd, hash] = match;
    const startLine = Number(rawStart);
    const endLine = Number(rawEnd);
    for (const attempt of attempts.values()) {
      if (attempt.kind !== "block") continue;
      if (
        attempt.path !== rawPath ||
        attempt.startLine !== startLine ||
        attempt.endLine !== endLine ||
        attempt.contentHash !== hash
      ) {
        continue;
      }
      pushVisible(visible, attempt, attempt.lines);
      break;
    }
  }
}

function scanRequestMessages(
  messages: readonly Message[],
  attempts: ReadonlyMap<string, EvidenceReadAttempt>,
) {
  const visible: VisibleEvidenceLines[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    if (isMissingResultPlaceholder(message)) continue;
    const text = toolResultText(message);
    if (text === undefined) continue;
    scanEmittedBlocks(text, attempts, visible);
    const attempt = attempts.get(message.toolCallId);
    if (attempt === undefined) continue;
    const candidate =
      attempt.kind === "diff"
        ? (jsonField(text, "diff") ?? "")
        : (jsonField(text, "content") ?? text);
    pushVisible(visible, attempt, creditedLines(attempt, candidate));
  }
  return ((pinnedReturn: readonly VisibleEvidenceLines[]) => pinnedReturn)(visible);
}

export function createEvidenceHooks() {
  const evidence = hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const state = sessionStateFor(api.conversationId);
      if (state === undefined) return undefined;
      const send = state.currentSend;
      if (send !== undefined) send.lastActivityAt = Date.now();
      state.trace?.event({ type: "turn_start" });
      const visible: VisibleEvidenceLines[] = [
        ...scanRequestMessages(messages, state.evidence.attempts),
      ];
      for (const recon of state.evidence.reconLines) {
        const lines: number[] = [];
        for (let line = recon.startLine; line <= recon.endLine; line += 1) {
          lines.push(line);
        }
        if (lines.length > 0) {
          visible.push({
            path: recon.path,
            headSha: state.headSha ?? "",
            tool: "recon_pack",
            contentHash: recon.contentHash,
            startLine: recon.startLine,
            endLine: recon.endLine,
            lines,
            content: recon.content,
          });
        }
      }
      const key = `evidence-request-${send?.assistantIndex ?? state.evidence.bindings.length}`;
      state.evidence.requestVisible.set(key, visible);
      await api.memo(key, JSON.parse(JSON.stringify(visible)), context);
      return undefined;
    },
    afterResponse: async (message, api, context) => {
      const state = sessionStateFor(api.conversationId);
      const send = state?.currentSend;
      if (state === undefined || send === undefined) return;
      send.lastActivityAt = Date.now();
      send.assistantIndex += 1;
      const visible =
        state.evidence.requestVisible.get(`evidence-request-${send.assistantIndex - 1}`) ?? [];
      const binding = {
        assistantIndex: send.assistantIndex,
        visible,
      };
      state.evidence.bindings.push(binding);
      await api.memo(
        `evidence-binding-${send.assistantIndex}`,
        JSON.parse(JSON.stringify(binding)),
        context,
      );
      state.trace?.event({ type: "message_end", message });
    },
  });
  return ((pinnedReturn: readonly HookRegistration[]) => pinnedReturn)([evidence]);
}
