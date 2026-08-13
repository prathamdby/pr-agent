import type { IntakeClient } from "../db/postgres.js";
import * as v from "valibot";
import { VERIFICATION_PUBLISH_LENS } from "../settings/index.js";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  jsonValueSchema,
  type JsonValue,
} from "../util/jsonValue.js";
import { recordPublishStep } from "./repository.js";

type VerificationThreadVerdict = "skipped" | "dismissed" | "fixed" | "already-resolved";

export type VerificationThreadState = {
  readonly stubCommentId?: number;
  readonly lastVerdict: VerificationThreadVerdict;
  readonly lastHeadSha?: string;
  readonly terminal?: boolean;
};

type MutableVerificationThreadState = {
  -readonly [K in keyof VerificationThreadState]: VerificationThreadState[K];
};

export type VerificationThreadLedger = {
  readonly threads: Readonly<Record<string, VerificationThreadState>>;
};

const VERIFICATION_THREAD_ACTIONS_STEP = "verification_thread_actions" as const;

function isVerdict(value: JsonValue): value is VerificationThreadVerdict {
  return (
    value === "skipped" ||
    value === "dismissed" ||
    value === "fixed" ||
    value === "already-resolved"
  );
}

function parseThreadState(value: JsonValue): VerificationThreadState | null {
  if (!isJsonObject(value)) return null;
  const lastVerdict = value.lastVerdict;
  if (lastVerdict === undefined || !isVerdict(lastVerdict)) return null;
  const stubCommentId = value.stubCommentId;
  const lastHeadSha = value.lastHeadSha;
  const terminal = value.terminal;
  const state: MutableVerificationThreadState = {
    lastVerdict,
  };
  if (
    stubCommentId !== undefined &&
    isJsonNumber(stubCommentId) &&
    Number.isInteger(stubCommentId)
  ) {
    state.stubCommentId = stubCommentId;
  }
  if (lastHeadSha !== undefined && isJsonString(lastHeadSha)) state.lastHeadSha = lastHeadSha;
  if (terminal === true) state.terminal = true;
  return state;
}

export function parseVerificationThreadLedger(detail?: JsonValue): VerificationThreadLedger {
  if (detail === undefined || !isJsonObject(detail)) {
    return { threads: {} };
  }
  const threadsValue = detail.threads;
  if (threadsValue !== undefined && isJsonObject(threadsValue)) {
    const threads: Record<string, VerificationThreadState> = {};
    for (const [key, value] of Object.entries(threadsValue)) {
      if (value === undefined) continue;
      const parsed = parseThreadState(value);
      if (parsed) threads[key] = parsed;
    }
    return { threads };
  }

  // Legacy shape from per-work-item actedThreadIds checkpoints.
  const acted = detail.actedThreadIds;
  if (!Array.isArray(acted)) {
    return { threads: {} };
  }
  const threads: Record<string, VerificationThreadState> = {};
  for (const item of acted) {
    if (!Number.isInteger(item)) continue;
    threads[String(item)] = { lastVerdict: "skipped" };
  }
  return { threads };
}

export async function loadVerificationThreadLedger(
  pool: IntakeClient,
  params: {
    readonly resourceKey: string;
  },
): Promise<VerificationThreadLedger> {
  const row = await pool.query<{ detail: unknown }>(
    `SELECT detail
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = $3
        AND status = 'completed'
      LIMIT 1`,
    [params.resourceKey, VERIFICATION_PUBLISH_LENS, VERIFICATION_THREAD_ACTIONS_STEP],
  );
  const raw = row.rows[0]?.detail;
  if (raw === undefined) return { threads: {} };
  return parseVerificationThreadLedger(v.parse(jsonValueSchema, raw));
}

export async function saveVerificationThreadLedger(
  pool: IntakeClient,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly ledger: VerificationThreadLedger;
    readonly executionEpoch: number;
  },
): Promise<void> {
  await recordPublishStep(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    step: VERIFICATION_THREAD_ACTIONS_STEP,
    detail: { threads: params.ledger.threads },
    executionEpoch: params.executionEpoch,
  });
}

export function upsertVerificationThreadState(
  ledger: VerificationThreadLedger,
  rootCommentId: number,
  state: VerificationThreadState,
): VerificationThreadLedger {
  return {
    threads: {
      ...ledger.threads,
      [String(rootCommentId)]: state,
    },
  };
}
