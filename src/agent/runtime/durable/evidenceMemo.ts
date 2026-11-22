import { GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { isRecord } from "../../../util/typeGuards.ts";
import { completePrefixLength } from "../../tools/toolOutputBudget.ts";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  type EvidenceLedger,
} from "../../../review/findings/evidenceLedger.ts";
import {
  sessionStateFor,
  visibleReadKey,
  type EvidenceReadAttempt,
  type VisibleRead,
} from "./sessionState.ts";

const EVIDENCE_FENCE_RE = /^(\S[^\n]*):(\d+)-(\d+) sha256:([0-9a-f]{64})\n```\n([\s\S]*?)\n```/gm;

function toolOutput(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function visibleRange(attempt: string, shown: string) {
  if (!shown) return undefined;
  let start = 0;
  let end = shown.length;
  if (attempt !== shown) {
    if (attempt.startsWith(shown)) end = completePrefixLength(attempt, shown);
    else if (attempt.endsWith(shown)) {
      start = attempt.length - shown.length;
      end = attempt.length;
      if (attempt[start - 1] !== "\n") {
        const newline = attempt.indexOf("\n", start);
        start = newline < 0 ? end : newline + 1;
      }
    } else return undefined;
  }
  if (end <= start) return undefined;
  const offset = attempt.slice(0, start).split("\n").length - 1;
  const lines = attempt.slice(start, end).replace(/\n$/, "").split("\n");
  return { offset, lines };
}

function visibleReads(attempt: EvidenceReadAttempt, shown: string) {
  const window = visibleRange(attempt.content, shown);
  if (!window) return [];
  const reads: VisibleRead[] = [];
  let text: string[] = [];
  let startLine = 0;
  const flush = () => {
    if (text.length === 0) return;
    const endLine = startLine + text.length - 1;
    const contentHash = hashNormalizedLineText(text.join("\n"));
    reads.push({
      path: normalizeEvidencePath(attempt.path),
      startLine,
      endLine,
      contentHash,
      headSha: attempt.headSha,
      tool: attempt.tool,
    });
    text = [];
  };
  for (const [index, lineText] of window.lines.entries()) {
    const line = attempt.lines[window.offset + index];
    if (line === undefined || line < 1 || attempt.clampedLines.includes(line)) {
      flush();
      continue;
    }
    if (line !== startLine + text.length) flush();
    if (text.length === 0) startLine = line;
    text.push((attempt.kind === "diff" ? lineText.slice(1) : lineText).replace(/\r$/, ""));
  }
  flush();
  return reads;
}

function requestReads(
  messages: readonly Message[],
  attempts: ReadonlyMap<string, readonly EvidenceReadAttempt[]>,
) {
  const reads: VisibleRead[] = [];
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      (isRecord(message.details) && message.details.reason === "missing_result")
    )
      continue;
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    for (const [, path, start, end, hash, body] of text.matchAll(EVIDENCE_FENCE_RE)) {
      for (const group of attempts.values()) {
        const match = group.find(
          (a) =>
            a.kind === "block" &&
            a.path === path &&
            a.startLine === Number(start) &&
            a.endLine === Number(end) &&
            a.contentHash === hash &&
            a.content === body,
        );
        if (match) {
          reads.push(...visibleReads(match, body));
          break;
        }
      }
    }
    const candidates = attempts.get(message.toolCallId);
    if (!candidates) continue;
    const output = toolOutput(text);
    const matches: VisibleRead[][] = [];
    for (const a of candidates) {
      if (
        a.kind === "block" ||
        (output?.path !== undefined && output.path !== a.path) ||
        (output?.startLine !== undefined && output.startLine !== a.startLine) ||
        (output?.endLine !== undefined && output.endLine !== a.endLine)
      )
        continue;
      const shown = a.kind === "diff" ? output?.diff : (output?.content ?? text);
      if (typeof shown !== "string") continue;
      const ranges = visibleReads(a, shown);
      if (ranges.length) matches.push(ranges);
    }
    if (matches.length === 1) reads.push(...matches[0]);
  }
  return reads;
}

export function creditVisibleReads(reads: Iterable<VisibleRead>, ledger: EvidenceLedger) {
  for (const read of reads) {
    const { tool: _tool, ...range } = read;
    ledger.record({ ...read, descriptor: { version: 1, kind: "file_range", ...range } });
  }
}

export function createEvidenceHooks() {
  const evidence = hook(GenerationTask, {
    beforeRequest: async ({ messages }, api) => {
      const state = sessionStateFor(api.conversationId);
      if (!state) return undefined;
      if (state.currentSend) state.currentSend.lastActivityAt = Date.now();
      state.trace?.event({ type: "turn_start" });
      const visible = requestReads(messages, state.evidence.attempts);
      for (const recon of state.evidence.reconLines) {
        visible.push(
          ...visibleReads(
            { ...recon, kind: "lines", headSha: state.headSha ?? "", tool: "recon_pack" },
            recon.content,
          ),
        );
      }
      const unseen = new Map<string, VisibleRead>();
      for (const read of visible) {
        const key = visibleReadKey(read);
        if (!state.evidence.credited.has(key)) unseen.set(key, read);
      }
      const pending = [...unseen.values()];
      if (state.journal && (pending.length || state.evidence.visible.length))
        await state.journal.pending(pending);
      state.evidence.visible = pending;
      return undefined;
    },
    afterResponse: async (message, api) => {
      const state = sessionStateFor(api.conversationId);
      if (!state?.currentSend) return;
      state.currentSend.lastActivityAt = Date.now();
      state.currentSend.assistantIndex += 1;
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        state.evidence.bound = state.evidence.visible;
        if (state.journal && state.evidence.bound.length) {
          await state.journal.credit(state.evidence.bound);
          for (const read of state.evidence.bound)
            state.evidence.credited.add(visibleReadKey(read));
          state.evidence.visible = [];
        }
      }
      state.trace?.event({ type: "message_end", message });
    },
  });
  return [evidence] satisfies readonly HookRegistration[];
}
