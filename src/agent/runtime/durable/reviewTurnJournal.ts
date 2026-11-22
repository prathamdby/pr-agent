import {
  defineDoc,
  type ConversationId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { PiSessionSendOptions } from "../types.ts";
import type { ReviewToolOutputs } from "../../../review/orchestrator/orchestratorRun.ts";
import {
  beginSend,
  includesEvidenceRead,
  visibleReadKey,
  type DurableSessionState,
  type EvidenceReadAttempt,
  type VisibleRead,
} from "./sessionState.ts";

const outputs = defineDoc<JsonRepresentation<ReviewToolOutputs>>({
  kind: "pr.review_outputs",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

export async function reviewOutputStore(harness: Harness, id: TaskId) {
  return {
    outputs: (await harness.snapshot(outputs, id, BACKGROUND_CONTEXT)) ?? {},
    saveOutput: (update: ReviewToolOutputs) =>
      harness.commit(async (tx) => {
        Object.assign(
          await tx.doc(outputs, id),
          copyJson(update, { omitUndefinedProperties: true }),
        );
      }, BACKGROUND_CONTEXT),
  };
}

type ReviewTurnJournal = {
  turn: { opts: PiSessionSendOptions; counted: number[]; blocked: number[] } | null;
  reads: Record<string, JsonRepresentation<EvidenceReadAttempt>[]>;
  credited: VisibleRead[];
  pending: VisibleRead[];
};

const journal = defineDoc<ReviewTurnJournal>({
  kind: "pr.review_turns",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ turn: null, reads: {}, credited: [], pending: [] }),
  checkpointWhen: () => false,
});

export async function journalReviewTurn(tx: Tx, id: ConversationId, opts: PiSessionSendOptions) {
  const doc = await tx.doc(journal, id);
  doc.turn = { opts, counted: [], blocked: [] };
}

export async function bindReviewJournal(
  harness: Harness,
  id: ConversationId,
  state: DurableSessionState,
  applyEvidence: (reads: readonly VisibleRead[]) => void,
) {
  const snapshot = await harness.snapshot(journal, id, BACKGROUND_CONTEXT);
  if (snapshot) {
    for (const [key, reads] of Object.entries(snapshot.reads))
      state.evidence.attempts.set(key.slice(1), reads);
    for (const read of snapshot.credited) state.evidence.credited.add(visibleReadKey(read));
    applyEvidence(snapshot.credited);
    state.evidence.visible = snapshot.pending;
    if (snapshot.turn) {
      const { opts, counted, blocked } = snapshot.turn;
      state.currentSend = {
        ...beginSend(opts),
        countedCalls: new Set(counted),
        blockedCalls: new Set(blocked),
        stopped: blocked.length > 0,
      };
    }
  }
  const write = (apply: (doc: ReviewTurnJournal) => void) =>
    harness.commit(async (tx) => apply(await tx.doc(journal, id)), BACKGROUND_CONTEXT);
  state.journal = {
    charge: (taskId, blocked) =>
      write(({ turn }) => {
        if (!turn) throw new Error("review tool has no submitted turn");
        const calls = blocked ? turn.blocked : turn.counted;
        if (!calls.includes(taskId)) calls.push(taskId);
      }),
    read: (callId, read) =>
      write((doc) => {
        const key = `:${callId}`;
        const reads = doc.reads[key] ?? [];
        if (!includesEvidenceRead(reads, read))
          doc.reads[key] = [
            ...reads,
            { ...read, lines: [...read.lines], clampedLines: [...read.clampedLines] },
          ];
      }),
    pending: (reads) =>
      write((doc) => {
        doc.pending = [...reads];
      }),
    credit: async (reads) => {
      await write((doc) => {
        doc.credited.push(...reads);
        doc.pending = [];
      });
      applyEvidence(reads);
    },
  };
}
