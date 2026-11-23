import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { releaseAskQuotaReservationTx } from "./askQuotas.ts";
import { readRow, readRows } from "./db.ts";

export const WORK_RUN_ACTIVE_STATUSES = ["pending_dispatch", "retry_scheduled", "running"] as const;

export const WORK_RUN_STATUSES = [
  ...WORK_RUN_ACTIVE_STATUSES,
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type WorkRunStatus = (typeof WORK_RUN_STATUSES)[number];

export const WORK_RUN_KINDS = [
  "review",
  "ask",
  "description",
  "triage",
  "verification",
  "ack",
  "ci_projection",
] as const;
export type WorkRunKind = (typeof WORK_RUN_KINDS)[number];

export function isFeatureWorkKind(kind: WorkRunKind) {
  return kind !== "review" && kind !== "ack";
}

export type FeatureWorkKind = Exclude<WorkRunKind, "review" | "ack">;

const WORK_RUN_LANES = ["review", "description", "verification", "triage", "none"] as const;
export type WorkRunLane = (typeof WORK_RUN_LANES)[number];

const workRunRowSchema = v.object({
  work_id: v.string(),
  pr_key: v.string(),
  kind: v.picklist(WORK_RUN_KINDS),
  lane: v.picklist(WORK_RUN_LANES),
  lane_epoch: v.number(),
  status: v.picklist(WORK_RUN_STATUSES),
  current_attempt_no: v.number(),
  next_retry_at: v.nullable(v.number()),
  cancel_reason: v.nullable(v.string()),
  payload_json: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});
export type WorkRunRow = v.InferOutput<typeof workRunRowSchema>;

const workRunAttemptRowSchema = v.object({
  work_id: v.string(),
  attempt_no: v.number(),
  attempt_id: v.string(),
  status: v.string(),
  conversation_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
  started_at: v.nullable(v.number()),
  finished_at: v.nullable(v.number()),
  error_json: v.nullable(v.string()),
});
export type WorkRunAttemptRow = v.InferOutput<typeof workRunAttemptRowSchema>;

const epochRowSchema = v.object({ epoch: v.optional(v.number()) });
const conversationIdRowSchema = v.object({ conversation_id: v.nullish(v.string()) });

export type ClaimedWorkRun = {
  readonly run: WorkRunRow;
  readonly attempt: WorkRunAttemptRow;
};

const LANE_EPOCH_COLUMN: Record<Exclude<WorkRunLane, "none">, string> = {
  review: "auto_review_epoch",
  description: "description_epoch",
  verification: "verification_epoch",
  triage: "triage_epoch",
};

export function laneForKind(kind: WorkRunKind) {
  return ((pinnedReturn: WorkRunLane) => pinnedReturn)(
    kind === "review" || kind === "description" || kind === "verification" || kind === "triage"
      ? kind
      : "none",
  );
}

export function laneEpochCurrent(db: DatabaseSync, run: WorkRunRow) {
  if (run.lane === "none") return true;
  const column = LANE_EPOCH_COLUMN[run.lane];
  const row = readRow(
    db.prepare(`SELECT ${column} AS epoch FROM pr_state WHERE pr_key = ?`).get(run.pr_key),
    epochRowSchema,
  );
  return row?.epoch === run.lane_epoch;
}

export function insertWorkRun(
  db: DatabaseSync,
  run: {
    readonly workId: string;
    readonly prKey: string;
    readonly kind: WorkRunKind;
    readonly laneEpoch?: number;
    readonly payloadJson: string;
    readonly now: number;
  },
) {
  const lane = laneForKind(run.kind);
  db.prepare(
    `INSERT INTO work_runs
      (work_id, pr_key, kind, lane, lane_epoch, status, current_attempt_no, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending_dispatch', 0, ?, ?, ?)`,
  ).run(
    run.workId,
    run.prKey,
    run.kind,
    lane,
    run.laneEpoch ?? 0,
    run.payloadJson,
    run.now,
    run.now,
  );
}

export function workRunById(db: DatabaseSync, workId: string) {
  return ((pinnedReturn: WorkRunRow | undefined) => pinnedReturn)(
    readRow(db.prepare(`SELECT * FROM work_runs WHERE work_id = ?`).get(workId), workRunRowSchema),
  );
}

function dispatchableRows(kinds: readonly WorkRunKind[]) {
  return `FROM work_runs w LEFT JOIN pr_state p ON p.pr_key = w.pr_key
    WHERE w.cancel_reason IS NULL
      AND w.kind IN (${kinds.map(() => "?").join(", ")})
      AND (w.lane = 'none' OR w.lane_epoch = CASE w.lane
        WHEN 'review' THEN p.auto_review_epoch WHEN 'description' THEN p.description_epoch
        WHEN 'verification' THEN p.verification_epoch WHEN 'triage' THEN p.triage_epoch END)
      AND NOT EXISTS (SELECT 1 FROM work_run_attempts a WHERE a.work_id = w.work_id
        AND a.status IN ('starting', 'running'))`;
}

export function claimDispatchableWorkRun(
  db: DatabaseSync,
  now: number,
  options?: { readonly kinds?: readonly WorkRunKind[] },
) {
  const kinds = options?.kinds ?? WORK_RUN_KINDS;
  if (kinds.length === 0) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
  const candidate = readRow(
    db
      .prepare(
        `SELECT w.* ${dispatchableRows(kinds)}
            AND (w.status = 'pending_dispatch' OR (w.status = 'retry_scheduled' AND w.next_retry_at <= ?))
          ORDER BY w.created_at, w.rowid
          LIMIT 1`,
      )
      .get(...kinds, now),
    workRunRowSchema,
  );
  if (candidate === undefined) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
  const attemptNo = candidate.current_attempt_no + 1;
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO work_run_attempts
      (work_id, attempt_no, attempt_id, status, started_at)
     VALUES (?, ?, ?, 'starting', ?)`,
  ).run(candidate.work_id, attemptNo, attemptId, now);
  db.prepare(`UPDATE work_runs SET current_attempt_no = ?, updated_at = ? WHERE work_id = ?`).run(
    attemptNo,
    now,
    candidate.work_id,
  );
  const attempt = attemptFor(db, candidate.work_id, attemptNo);
  if (attempt === undefined) throw new Error("work run attempt insert produced no row");
  return ((pinnedReturn: ClaimedWorkRun) => pinnedReturn)({
    run: { ...candidate, current_attempt_no: attemptNo, updated_at: now },
    attempt,
  });
}

export function nextDispatchWakeAt(db: DatabaseSync, kinds: readonly WorkRunKind[]) {
  if (kinds.length === 0) return undefined;
  const row = readRow(
    db
      .prepare(
        `SELECT MIN(w.next_retry_at) AS next_retry_at ${dispatchableRows(kinds)} AND w.status = 'retry_scheduled'`,
      )
      .get(...kinds),
    v.object({ next_retry_at: v.nullable(v.number()) }),
  );
  return ((pinnedReturn: number | undefined) => pinnedReturn)(row?.next_retry_at ?? undefined);
}

export function liveAttemptCounts(db: DatabaseSync) {
  const row = readRow(
    db
      .prepare(
        `SELECT COUNT(*) AS live FROM work_run_attempts WHERE status IN ('starting', 'running')`,
      )
      .get(),
    v.object({ live: v.number() }),
  );
  return ((pinnedReturn: number) => pinnedReturn)(row?.live ?? 0);
}

export function markAttemptRunning(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly attemptNo: number;
    readonly conversationId: string | null;
    readonly taskId: string | null;
    readonly now: number;
  },
) {
  const updated = db
    .prepare(
      `UPDATE work_run_attempts
          SET status = 'running', conversation_id = ?, task_id = ?
        WHERE work_id = ? AND attempt_no = ? AND status = 'starting'`,
    )
    .run(params.conversationId, params.taskId, params.workId, params.attemptNo).changes;
  if (updated === 0) return 0;
  const runUpdated = db
    .prepare(
      `UPDATE work_runs SET status = 'running', updated_at = ?
        WHERE work_id = ? AND status IN ('pending_dispatch', 'retry_scheduled', 'running')
          AND cancel_reason IS NULL`,
    )
    .run(params.now, params.workId).changes;
  if (runUpdated === 0) {
    db.prepare(
      `UPDATE work_run_attempts SET status = 'cancelled', finished_at = ?
        WHERE work_id = ? AND attempt_no = ?`,
    ).run(params.now, params.workId, params.attemptNo);
    return 0;
  }
  return runUpdated;
}

function finishAttempt(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly attemptNo: number;
    readonly status: string;
    readonly errorJson?: string;
    readonly now: number;
  },
) {
  return db
    .prepare(
      `UPDATE work_run_attempts SET status = ?, finished_at = ?, error_json = COALESCE(?, error_json)
        WHERE work_id = ? AND attempt_no = ? AND status IN ('starting', 'running')`,
    )
    .run(params.status, params.now, params.errorJson ?? null, params.workId, params.attemptNo)
    .changes;
}

export function cancelLiveAttempt(
  db: DatabaseSync,
  params: { readonly workId: string; readonly attemptNo: number; readonly now: number },
) {
  return ((pinnedReturn: number) => pinnedReturn)(
    Number(finishAttempt(db, { ...params, status: "cancelled" })),
  );
}

export function markWorkRunCompleted(
  db: DatabaseSync,
  params: { readonly workId: string; readonly attemptNo: number; readonly now: number },
) {
  if (finishAttempt(db, { ...params, status: "completed" }) === 0) return 0;
  const updated = db
    .prepare(
      `UPDATE work_runs SET status = 'completed', updated_at = ?, next_retry_at = NULL
        WHERE work_id = ? AND status = 'running' AND current_attempt_no = ?`,
    )
    .run(params.now, params.workId, params.attemptNo).changes;
  if (updated > 0) releaseAskQuotaReservationTx(db, params.workId, params.now);
  return ((pinnedReturn: number) => pinnedReturn)(Number(updated));
}

export function markWorkRunFailed(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly attemptNo: number;
    readonly errorJson: string;
    readonly now: number;
  },
) {
  if (finishAttempt(db, { ...params, status: "failed" }) === 0) return 0;
  const updated = db
    .prepare(
      `UPDATE work_runs SET status = 'failed', updated_at = ?, next_retry_at = NULL
        WHERE work_id = ? AND status IN ('pending_dispatch', 'retry_scheduled', 'running')
          AND current_attempt_no = ?`,
    )
    .run(params.now, params.workId, params.attemptNo).changes;
  if (updated > 0) releaseAskQuotaReservationTx(db, params.workId, params.now);
  return ((pinnedReturn: number) => pinnedReturn)(Number(updated));
}

export function scheduleWorkRunRetry(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly attemptNo: number;
    readonly errorJson: string;
    readonly nextRetryAt: number;
    readonly now: number;
  },
) {
  if (finishAttempt(db, { ...params, status: "failed" }) === 0) return 0;
  return ((pinnedReturn: number) => pinnedReturn)(
    Number(
      db
        .prepare(
          `UPDATE work_runs SET status = 'retry_scheduled', next_retry_at = ?, updated_at = ?
            WHERE work_id = ? AND status IN ('pending_dispatch', 'retry_scheduled', 'running')
              AND cancel_reason IS NULL AND current_attempt_no = ?`,
        )
        .run(params.nextRetryAt, params.now, params.workId, params.attemptNo).changes,
    ),
  );
}

export function nextRetryAtMs(
  attemptNo: number,
  queue: { readonly retryDelaySeconds: number; readonly retryDelayMaxSeconds: number },
  now: number,
) {
  const delaySeconds = Math.min(
    queue.retryDelaySeconds * 2 ** Math.max(0, attemptNo - 1),
    queue.retryDelayMaxSeconds,
  );
  return ((pinnedReturn: number) => pinnedReturn)(now + delaySeconds * 1000);
}

export function cancelWorkRun(
  db: DatabaseSync,
  params: { readonly workId: string; readonly reason: string; readonly now: number },
) {
  db.prepare(
    `UPDATE work_runs SET status = 'cancelled', cancel_reason = ?, updated_at = ?
      WHERE work_id = ? AND status IN ('pending_dispatch', 'retry_scheduled', 'running')`,
  ).run(params.reason, params.now, params.workId);
  const attempt = readRow(
    db
      .prepare(
        `SELECT conversation_id FROM work_run_attempts
        WHERE work_id = ? AND status IN ('starting', 'running')
        ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(params.workId),
    conversationIdRowSchema,
  );
  db.prepare(
    `UPDATE work_run_attempts SET status = 'cancelled', finished_at = ?
      WHERE work_id = ? AND status IN ('starting', 'running')`,
  ).run(params.now, params.workId);
  releaseAskQuotaReservationTx(db, params.workId, params.now);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    attempt?.conversation_id ?? undefined,
  );
}

export function supersedeWorkRun(
  db: DatabaseSync,
  params: { readonly workId: string; readonly now: number },
) {
  db.prepare(
    `UPDATE work_runs SET status = 'superseded', updated_at = ?
      WHERE work_id = ? AND status IN ('pending_dispatch', 'retry_scheduled', 'running')`,
  ).run(params.now, params.workId);
  const attempt = readRow(
    db
      .prepare(
        `SELECT conversation_id FROM work_run_attempts
        WHERE work_id = ? AND status IN ('starting', 'running')
        ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(params.workId),
    conversationIdRowSchema,
  );
  db.prepare(
    `UPDATE work_run_attempts SET status = 'cancelled', finished_at = ?
      WHERE work_id = ? AND status IN ('starting', 'running')`,
  ).run(params.now, params.workId);
  releaseAskQuotaReservationTx(db, params.workId, params.now);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    attempt?.conversation_id ?? undefined,
  );
}

export function bumpLaneEpoch(
  db: DatabaseSync,
  params: { readonly prKey: string; readonly lane: WorkRunLane; readonly now: number },
) {
  if (params.lane === "none") return;
  const column = LANE_EPOCH_COLUMN[params.lane];
  db.prepare(`UPDATE pr_state SET ${column} = ${column} + 1, updated_at = ? WHERE pr_key = ?`).run(
    params.now,
    params.prKey,
  );
}

export function attemptFor(db: DatabaseSync, workId: string, attemptNo: number) {
  return ((pinnedReturn: WorkRunAttemptRow | undefined) => pinnedReturn)(
    readRow(
      db
        .prepare(`SELECT * FROM work_run_attempts WHERE work_id = ? AND attempt_no = ?`)
        .get(workId, attemptNo),
      workRunAttemptRowSchema,
    ),
  );
}

export function unfinishedAttempts(db: DatabaseSync) {
  return ((pinnedReturn: readonly WorkRunAttemptRow[]) => pinnedReturn)(
    readRows(
      db.prepare(`SELECT * FROM work_run_attempts WHERE status IN ('starting', 'running')`).all(),
      workRunAttemptRowSchema,
    ),
  );
}
