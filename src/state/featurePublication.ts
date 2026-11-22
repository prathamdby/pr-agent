import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { AppError } from "../errors/appError.ts";
import { isAnyReviewLens, type AnyReviewLens } from "../settings/index.ts";
import { isRecord } from "../util/typeGuards.ts";
import { readRow, readRows } from "./db.ts";
import {
  intentKeyFor,
  publishIntentRowSchema,
  publishOnce,
  sharedPublishRecordKey,
  workPublishRecordKey,
  type PublishIntentRow,
  type PublishOnceParams,
} from "./publish.ts";
import { laneEpochCurrent, workRunById, type WorkRunStatus } from "./workRuns.ts";

export type FeaturePublishParams<T> = Omit<
  PublishOnceParams<T>,
  "db" | "workId" | "prKey" | "laneEpoch" | "shutdownRequested" | "now" | "decodeResult"
> & {
  readonly prKey?: string;
  readonly decodeResult: (value: unknown) => T;
};

export type FeaturePublication = {
  readonly db: DatabaseSync;
  readonly workId: string;
  readonly prKey: string;
  readonly laneEpoch: number | null;
  readonly once: <T>(params: FeaturePublishParams<T>) => Promise<T>;
  readonly intent: (operationKey: string) => PublishIntentRow | undefined;
  readonly record: (params: {
    readonly lens: string;
    readonly step: string;
    readonly detail?: Record<string, unknown>;
    readonly prKey?: string;
    readonly workId?: string;
  }) => void;
  readonly completed: (step: string) => Record<string, unknown> | undefined;
  readonly latestWithoutNewer: (
    lens: string,
    step: string,
    newerStep: string,
  ) => Record<string, unknown> | undefined;
  readonly latest: (
    lens: string,
    step: string,
    prKey?: string,
  ) => Record<string, unknown> | undefined;
  readonly current: () => boolean;
  readonly assertCurrent: () => void;
};

const payloadRowSchema = v.object({ payload_json: v.string() });

function parsePayload(raw: string | undefined) {
  if (raw === undefined)
    return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(undefined);
  const parsed: unknown = JSON.parse(raw);
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    isRecord(parsed) ? parsed : undefined,
  );
}

export function intentIdentity(intent: PublishIntentRow | undefined) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(
    intent === undefined ? {} : (parsePayload(intent.identity_json) ?? {}),
  );
}

export function intentResult(intent: PublishIntentRow | undefined) {
  if (intent?.result_json == null) return ((pinnedReturn: unknown) => pinnedReturn)(undefined);
  return ((pinnedReturn: unknown) => pinnedReturn)(JSON.parse(intent.result_json));
}

export function intentOutcomeUnknown(intent: PublishIntentRow | undefined) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    intent !== undefined &&
      (intent.state === "mutating" ||
        intent.state === "outcome_unknown_recoverable" ||
        intent.state === "outcome_unknown_terminal"),
  );
}

export function publishIntentFor(db: DatabaseSync, workId: string, operationKey: string) {
  return ((pinnedReturn: PublishIntentRow | undefined) => pinnedReturn)(
    readRow(
      db
        .prepare(`SELECT * FROM publish_intents WHERE intent_key = ?`)
        .get(intentKeyFor(workId, operationKey)),
      publishIntentRowSchema,
    ),
  );
}

export function recordPublishStep(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly prKey: string;
    readonly lens: string;
    readonly step: string;
    readonly detail?: Record<string, unknown>;
    readonly now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const payload = JSON.stringify(params.detail ?? {});
  const upsert = db.prepare(
    `INSERT INTO publish_records (record_key, pr_key, work_id, step, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (record_key) DO UPDATE SET
       work_id = excluded.work_id,
       payload_json = excluded.payload_json,
       created_at = excluded.created_at`,
  );
  upsert.run(
    workPublishRecordKey(params.workId, params.step),
    params.prKey,
    params.workId,
    params.step,
    payload,
    now,
  );
  upsert.run(
    sharedPublishRecordKey(params.prKey, params.lens, params.step),
    params.prKey,
    params.workId,
    params.step,
    payload,
    now,
  );
}

export function publishStepCompleted(db: DatabaseSync, workId: string, step: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    readRow(
      db
        .prepare(`SELECT payload_json FROM publish_records WHERE record_key = ?`)
        .get(workPublishRecordKey(workId, step)),
      payloadRowSchema,
    ) !== undefined,
  );
}

export function workPublishStepDetail(db: DatabaseSync, workId: string, step: string) {
  const row = readRow(
    db
      .prepare(`SELECT payload_json FROM publish_records WHERE record_key = ?`)
      .get(workPublishRecordKey(workId, step)),
    payloadRowSchema,
  );
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    parsePayload(row?.payload_json),
  );
}

export function latestPublishStep(db: DatabaseSync, prKey: string, lens: string, step: string) {
  const row = readRow(
    db
      .prepare(`SELECT payload_json FROM publish_records WHERE record_key = ?`)
      .get(sharedPublishRecordKey(prKey, lens, step)),
    payloadRowSchema,
  );
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    parsePayload(row?.payload_json),
  );
}

export function latestPublishStepWithoutNewer(
  db: DatabaseSync,
  prKey: string,
  lens: string,
  step: string,
  newerStep: string,
) {
  const timed = v.object({ payload_json: v.string(), created_at: v.number() });
  const select = db.prepare(
    `SELECT payload_json, created_at FROM publish_records WHERE record_key = ?`,
  );
  const current = readRow(select.get(sharedPublishRecordKey(prKey, lens, step)), timed);
  if (current === undefined)
    return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(undefined);
  const newer = readRow(select.get(sharedPublishRecordKey(prKey, lens, newerStep)), timed);
  if (newer !== undefined && newer.created_at >= current.created_at)
    return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    parsePayload(current.payload_json),
  );
}

export function progressCommentOwner(db: DatabaseSync, prKey: string, lens: string) {
  const row = readRow(
    db
      .prepare(`SELECT work_id, payload_json FROM publish_records WHERE record_key = ?`)
      .get(sharedPublishRecordKey(prKey, lens, "progress_comment")),
    v.object({ work_id: v.string(), payload_json: v.string() }),
  );
  if (row === undefined)
    return ((pinnedReturn: { readonly workId: string; readonly generation: number } | null) =>
      pinnedReturn)(null);
  const generation = parsePayload(row.payload_json)?.progressGeneration;
  return ((pinnedReturn: { readonly workId: string; readonly generation: number } | null) =>
    pinnedReturn)({
    workId: row.work_id,
    generation: typeof generation === "number" && Number.isFinite(generation) ? generation : 0,
  });
}

export function inlineReviewLensesForPr(db: DatabaseSync, prKey: string) {
  const rows = readRows(
    db
      .prepare(
        `SELECT payload_json FROM publish_records WHERE pr_key = ? AND step = 'inline_review'`,
      )
      .all(prKey),
    payloadRowSchema,
  );
  const lenses = new Map<number, AnyReviewLens>();
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    const reviewId = Number(payload?.githubId);
    const lens = payload?.reviewLens;
    if (
      Number.isSafeInteger(reviewId) &&
      reviewId > 0 &&
      typeof lens === "string" &&
      isAnyReviewLens(lens)
    ) {
      lenses.set(reviewId, lens);
    }
  }
  return ((pinnedReturn: ReadonlyMap<number, AnyReviewLens>) => pinnedReturn)(lenses);
}

export function workRunStatus(db: DatabaseSync, workId: string) {
  return ((pinnedReturn: WorkRunStatus | undefined) => pinnedReturn)(
    workRunById(db, workId)?.status,
  );
}

export function activeReviewWorkId(db: DatabaseSync, prKey: string) {
  const row = readRow(
    db
      .prepare(
        `SELECT work_id FROM work_runs
          WHERE pr_key = ? AND kind = 'review'
            AND status IN ('pending_dispatch', 'retry_scheduled', 'running')
          LIMIT 1`,
      )
      .get(prKey),
    v.object({ work_id: v.string() }),
  );
  return ((pinnedReturn: string | undefined) => pinnedReturn)(row?.work_id);
}

export function reviewQueuePosition(db: DatabaseSync, workId: string) {
  const row = readRow(
    db
      .prepare(
        `WITH target AS (
           SELECT work_id, created_at, pr_key FROM work_runs
            WHERE work_id = ? AND kind = 'review' AND status IN ('pending_dispatch', 'retry_scheduled')
         ),
         queued AS (
           SELECT q.work_id, q.created_at FROM work_runs q JOIN target t ON q.pr_key = t.pr_key
            WHERE q.kind = 'review' AND q.status IN ('pending_dispatch', 'retry_scheduled')
         )
         SELECT
           (SELECT COUNT(*) FROM queued q, target t
             WHERE q.created_at < t.created_at
                OR (q.created_at = t.created_at AND q.work_id <= t.work_id)) AS position,
           (SELECT COUNT(*) FROM queued) AS total
         FROM target`,
      )
      .get(workId),
    v.object({ position: v.number(), total: v.number() }),
  );
  if (row === undefined || row.position < 1 || row.total < row.position)
    return ((pinnedReturn: { readonly position: number; readonly total: number } | null) =>
      pinnedReturn)(null);
  return ((pinnedReturn: { readonly position: number; readonly total: number } | null) =>
    pinnedReturn)({ position: row.position, total: row.total });
}

export function workRunCurrent(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly laneEpoch: number | null;
    readonly shutdownRequested: () => boolean;
  },
) {
  if (params.shutdownRequested()) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const run = workRunById(db, params.workId);
  if (run === undefined) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (run.status !== "running" || run.cancel_reason !== null)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (params.laneEpoch !== null && run.lane_epoch !== params.laneEpoch)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(laneEpochCurrent(db, run));
}

export function createFeaturePublication(params: {
  readonly db: DatabaseSync;
  readonly workId: string;
  readonly prKey: string;
  readonly laneEpoch: number | null;
  readonly shutdownRequested: () => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}) {
  const now = params.now ?? Date.now;
  const current = () =>
    params.signal?.aborted !== true &&
    workRunCurrent(params.db, {
      workId: params.workId,
      laneEpoch: params.laneEpoch,
      shutdownRequested: params.shutdownRequested,
    });
  return ((pinnedReturn: FeaturePublication) => pinnedReturn)({
    db: params.db,
    workId: params.workId,
    prKey: params.prKey,
    laneEpoch: params.laneEpoch,
    once: (publish) =>
      publishOnce({
        ...publish,
        db: params.db,
        workId: params.workId,
        prKey: publish.prKey ?? params.prKey,
        laneEpoch: params.laneEpoch,
        shutdownRequested: params.shutdownRequested,
        signal: publish.signal ?? params.signal,
        now: now(),
      }),
    intent: (operationKey) => publishIntentFor(params.db, params.workId, operationKey),
    record: (record) =>
      recordPublishStep(params.db, {
        workId: record.workId ?? params.workId,
        prKey: record.prKey ?? params.prKey,
        lens: record.lens,
        step: record.step,
        ...(record.detail !== undefined ? { detail: record.detail } : {}),
        now: now(),
      }),
    completed: (step) => workPublishStepDetail(params.db, params.workId, step),
    latestWithoutNewer: (lens, step, newerStep) =>
      latestPublishStepWithoutNewer(params.db, params.prKey, lens, step, newerStep),
    latest: (lens, step, prKey) => latestPublishStep(params.db, prKey ?? params.prKey, lens, step),
    current,
    assertCurrent: () => {
      if (current()) return;
      throw new AppError({
        domain: "operation_intent",
        kind: "mutation_gate_failed",
        message: "Work run is no longer current for publication",
        context: { workId: params.workId },
      });
    },
  });
}

function askOperationKey(
  kind: "reply" | "failure_reply",
  resourceKey: string,
  targetCommentId?: number,
) {
  const base = `ask:${kind}:${resourceKey}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    targetCommentId == null ? base : `${base}:${targetCommentId}`,
  );
}

export function askReplyOperationKey(resourceKey: string, targetCommentId?: number) {
  return askOperationKey("reply", resourceKey, targetCommentId);
}

export function askFailureReplyOperationKey(resourceKey: string, targetCommentId?: number) {
  return askOperationKey("failure_reply", resourceKey, targetCommentId);
}

export function descriptionPrBodyOperationKey(resourceKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`description:pr_body:${resourceKey}`);
}

export function triagePushOperationKey(resourceKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`triage:push:${resourceKey}`);
}

export function triageThreadOperationKey(rootCommentId: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`triage:thread:${rootCommentId}`);
}

export function triageReportOperationKey(resourceKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`triage:report:${resourceKey}`);
}

export function triagePreviewOperationKey(resourceKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`triage:preview:${resourceKey}`);
}

export function verificationThreadOperationKey(rootCommentId: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`verification:thread:${rootCommentId}`);
}

export function verificationObjectionAnswerOperationKey(
  rootCommentId: number,
  objectionCommentId: number,
  updatedAt: string,
) {
  const digest = crypto.createHash("sha256").update(updatedAt).digest("hex");
  const revision = digest.slice(0, 16);
  return ((pinnedReturn: string) => pinnedReturn)(
    `verification:objection:${rootCommentId}:${objectionCommentId}:${revision}`,
  );
}

export function operationIntentMarker(operationKey: string, operationInstance: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:operation-intent ${crypto
      .createHash("sha256")
      .update(`${operationKey}\0${operationInstance}`)
      .digest("hex")
      .slice(0, 24)} -->`,
  );
}

export async function foundFromRecovery<T>(
  recovery: Promise<
    { readonly kind: "reconciled"; readonly value: T } | { readonly kind: "absent" }
  >,
) {
  const resolved = await recovery;
  return ((pinnedReturn: { readonly found: true; readonly value: T } | { readonly found: false }) =>
    pinnedReturn)(
    resolved.kind === "reconciled" ? { found: true, value: resolved.value } : { found: false },
  );
}

export function approvalNoticePublishable(
  db: DatabaseSync,
  prKey: string,
  state: "awaiting" | "withdrawn",
) {
  const row = readRow(
    db.prepare(`SELECT lifecycle_state, approval_json FROM pr_state WHERE pr_key = ?`).get(prKey),
    v.object({ lifecycle_state: v.string(), approval_json: v.nullable(v.string()) }),
  );
  if (row?.approval_json == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const approval = parsePayload(row.approval_json);
  if (approval?.state !== state) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const progress = readRow(
    db
      .prepare(
        `SELECT record_key FROM publish_records WHERE pr_key = ? AND step = 'progress_comment' LIMIT 1`,
      )
      .get(prKey),
    v.object({ record_key: v.string() }),
  );
  if (progress !== undefined) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    state === "awaiting" || row.lifecycle_state === "closed" || row.lifecycle_state === "merged",
  );
}
