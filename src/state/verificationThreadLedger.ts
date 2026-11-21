import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import {
  parseVerificationThreadLedger,
  type VerificationThreadLedger,
} from "../agentWork/verificationThreadLedger.ts";
import { VERIFICATION_PUBLISH_LENS } from "../settings/index.ts";
import { readRow } from "./db.ts";
import { sharedPublishRecordKey } from "./publish.ts";

export {
  clearVerificationFailureSignalFromLedger,
  matchesVerificationThreadCompletion,
  parseVerificationThreadLedger,
  upsertVerificationFailureSignal,
  upsertVerificationThreadState,
} from "../agentWork/verificationThreadLedger.ts";
export type {
  VerificationFailureSignal,
  VerificationFailureSurface,
  VerificationObjectionJournalEntry,
  VerificationThreadCompletion,
  VerificationThreadLedger,
  VerificationThreadState,
} from "../agentWork/verificationThreadLedger.ts";

const VERIFICATION_THREAD_ACTIONS_STEP = "verification_thread_actions" as const;

export function loadVerificationThreadLedger(
  db: DatabaseSync,
  params: { readonly resourceKey: string },
) {
  const row = readRow(
    db
      .prepare(`SELECT payload_json FROM publish_records WHERE record_key = ?`)
      .get(
        sharedPublishRecordKey(
          params.resourceKey,
          VERIFICATION_PUBLISH_LENS,
          VERIFICATION_THREAD_ACTIONS_STEP,
        ),
      ),
    v.object({ payload_json: v.optional(v.string()) }),
  );
  const detail: unknown = row?.payload_json == null ? undefined : JSON.parse(row.payload_json);
  return ((pinnedReturn: VerificationThreadLedger) => pinnedReturn)(
    parseVerificationThreadLedger(detail),
  );
}

export function saveVerificationThreadLedger(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly resourceKey: string;
    readonly ledger: VerificationThreadLedger;
    readonly now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const payload = JSON.stringify({
    threads: params.ledger.threads,
    ...(params.ledger.failureSignal != null ? { failureSignal: params.ledger.failureSignal } : {}),
  });
  const recordKey = sharedPublishRecordKey(
    params.resourceKey,
    VERIFICATION_PUBLISH_LENS,
    VERIFICATION_THREAD_ACTIONS_STEP,
  );
  db.prepare(
    `INSERT INTO publish_records (record_key, pr_key, work_id, step, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (record_key) DO UPDATE SET payload_json = excluded.payload_json`,
  ).run(
    recordKey,
    params.resourceKey,
    params.workId,
    VERIFICATION_THREAD_ACTIONS_STEP,
    payload,
    now,
  );
}
