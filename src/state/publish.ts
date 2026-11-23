import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { AppError, throwIfAborted } from "../errors/appError.ts";
import type { AppErrorKind } from "../errors/appErrorCodes.ts";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.ts";
import type {
  OperationIntentRecovery,
  OperationIntentRow,
} from "../github/recoverPrSurfaceMutation.ts";
import type {
  PrSurface,
  PrSurfaceMutation,
  PrSurfaceMutationBoundary,
} from "../github/prSurfaceTypes.ts";
import { rediscoverBotArtifacts } from "../github/recoverPrSurfaceMutation.ts";
import { isRecord } from "../util/typeGuards.ts";
import { immediate, readRow, readRows } from "./db.ts";

export type PublishDb = DatabaseSync;

const operationIntentFrame = new AsyncLocalStorage<{ readonly operationKey: string }>();

export function runInOperationIntentFrame<T>(operationKey: string, fn: () => T) {
  return ((pinnedReturn: T) => pinnedReturn)(operationIntentFrame.run({ operationKey }, fn));
}

export function currentOperationIntentKey() {
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    operationIntentFrame.getStore()?.operationKey,
  );
}

export function reviewInlineBatchOperationKey(batchId: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`review:inline:${batchId}`);
}

export function deterministicInlineBatchId(params: {
  readonly workItemId: string;
  readonly headSha: string;
  readonly findingIds: readonly string[];
}) {
  const material = [params.workItemId, params.headSha, ...params.findingIds.toSorted()].join("\0");
  const digest = crypto.createHash("sha256").update(material).digest("hex");
  return digest.slice(0, 32);
}

export function reviewDuplicateOperationKey(step: {
  readonly kind: "duplicate_reply" | "duplicate_resolve";
  readonly duplicateId: string;
  readonly canonicalId: string;
  readonly threadId: string;
}) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `review:${step.kind}:${step.duplicateId}:${step.canonicalId}:${step.threadId}`,
  );
}

export function reviewSummaryOperationKey(resourceKey: string, reviewLens: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`review:summary:${reviewLens}:${resourceKey}`);
}

export function reviewCheckOperationKey(workItemId: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`review:check_run:${workItemId}`);
}

export function reviewCheckCloseOperationKey(workItemId: string, reviewLens: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `review:check_run_close:${workItemId}:${reviewLens}`,
  );
}

export function reviewCommitStatusOperationKey(
  resourceKey: string,
  headSha: string,
  state: "pending" | "success" | "failure" | "error",
) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `review:commit_status:${resourceKey}:${headSha}:${state}`,
  );
}

export function reviewLabelsOperationKey(resourceKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`review:labels:${resourceKey}`);
}

export function reviewVerdictReviewOperationKey(workItemId: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`review:verdict_review:${workItemId}`);
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

const PUBLISH_INTENT_STATES = [
  "reserved",
  "mutating",
  "reconciled",
  "mutation_failed",
  "outcome_unknown_recoverable",
  "outcome_unknown_terminal",
] as const;
export type PublishIntentState = (typeof PUBLISH_INTENT_STATES)[number];

export const publishIntentRowSchema = v.object({
  intent_key: v.string(),
  pr_key: v.string(),
  work_id: v.string(),
  resource_target: v.string(),
  operation_key: v.string(),
  state: v.picklist(PUBLISH_INTENT_STATES),
  mutation_kind: v.string(),
  identity_json: v.string(),
  result_json: v.nullable(v.string()),
  updated_at: v.number(),
});
export type PublishIntentRow = v.InferOutput<typeof publishIntentRowSchema>;

export type PublishRecovery =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false };

export type PublishGate = "running" | "cleanup";

export type PublishOnceParams<T> = {
  readonly db: DatabaseSync;
  readonly workId: string;
  readonly prKey: string;
  readonly resourceTarget: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly identity?: Record<string, unknown>;
  readonly blocksOverwrite?: boolean;
  readonly gate?: PublishGate;
  readonly laneEpoch?: number | null;
  readonly shutdownRequested?: () => boolean;
  readonly publishRecordKeys?: readonly {
    readonly recordKey: string;
    readonly step: string;
    readonly payloadJson: string;
  }[];
  readonly verdictRetentionJson?: string;
  readonly onReconciled?: (db: DatabaseSync, value: unknown, now: number) => void;
  readonly mutate: () => Promise<T>;
  readonly decodeResult?: (value: unknown) => T;
  readonly allowsUndefinedResult?: boolean;
  readonly isKnownNoAcceptanceError?: (error: unknown) => boolean;
  readonly failClosed?: boolean;
  readonly recover?: (intent: PublishIntentRow) => Promise<PublishRecovery>;
  readonly signal?: AbortSignal;
  readonly now?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const UNKNOWN_MUTATION_MESSAGE =
  "Mutation outcome unknown after crash between mutating and reconciled; remutate forbidden";
const RECONCILED_REMUTATE_MESSAGE =
  "Reconciled mutation has no stored result and recovery cannot rebuild it; remutate forbidden";
const LOOKUP_RETRIES = 3;
const LOOKUP_BACKOFF_MS = [250, 500, 1000] as const;
const CLEANUP_STATUSES: ReadonlySet<string> = new Set(["running", "cancelled", "superseded"]);

export function intentKeyFor(workId: string, operationKey: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`${workId}:${operationKey}`);
}

function publishError(
  kind: AppErrorKind<"operation_intent">,
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({
      domain: "operation_intent",
      kind,
      message,
      cause,
      context,
    }),
  );
}

function intentByKey(db: DatabaseSync, intentKey: string) {
  return ((pinnedReturn: PublishIntentRow | undefined) => pinnedReturn)(
    readRow(
      db.prepare(`SELECT * FROM publish_intents WHERE intent_key = ?`).get(intentKey),
      publishIntentRowSchema,
    ),
  );
}

export function publishIntent(db: DatabaseSync, workId: string, operationKey: string) {
  return ((pinnedReturn: PublishIntentRow | undefined) => pinnedReturn)(
    intentByKey(db, intentKeyFor(workId, operationKey)),
  );
}

export function intentIdentity(intent: PublishIntentRow) {
  const parsed: unknown = JSON.parse(intent.identity_json);
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(isRecord(parsed) ? parsed : {});
}

export function intentResult(intent: PublishIntentRow) {
  return ((pinnedReturn: unknown) => pinnedReturn)(
    intent.result_json === null ? undefined : JSON.parse(intent.result_json),
  );
}

export function toOperationIntentRow(intent: PublishIntentRow) {
  return ((pinnedReturn: OperationIntentRow) => pinnedReturn)({
    id: intent.intent_key,
    workItemId: intent.work_id,
    operationKey: intent.operation_key,
    mutationKind: intent.mutation_kind,
    status:
      intent.state === "reconciled"
        ? "reconciled"
        : intent.state === "mutation_failed"
          ? "failed"
          : intent.state === "outcome_unknown_recoverable" ||
              intent.state === "outcome_unknown_terminal"
            ? "outcome_unknown"
            : "pending",
    publishRecordId: null,
    detail: intentIdentity(intent),
  });
}

const laneColumnRowSchema = v.object({ epoch: v.optional(v.nullable(v.number())) });
const runGateRowSchema = v.object({
  status: v.string(),
  lane: v.string(),
  lane_epoch: v.number(),
});
const conflictRowSchema = v.object({ intent_key: v.string(), state: v.string() });

function laneEpochHeld(db: DatabaseSync, prKey: string, lane: string, epoch: number) {
  const columnByLane: Record<string, string> = {
    review: "auto_review_epoch",
    description: "description_epoch",
    verification: "verification_epoch",
    triage: "triage_epoch",
  };
  const column = Object.hasOwn(columnByLane, lane) ? columnByLane[lane] : undefined;
  if (column === undefined) return false;
  const row = readRow(
    db.prepare(`SELECT ${column} AS epoch FROM pr_state WHERE pr_key = ?`).get(prKey),
    laneColumnRowSchema,
  );
  return row?.epoch === epoch;
}

type RunGate = {
  readonly workId: string;
  readonly prKey: string;
  readonly operationKey?: string;
  readonly gate?: PublishGate;
  readonly laneEpoch?: number | null;
  readonly shutdownRequested?: () => boolean;
};

function runGateFailure(db: DatabaseSync, params: RunGate) {
  const run = readRow(
    db
      .prepare(`SELECT status, lane, lane_epoch FROM work_runs WHERE work_id = ?`)
      .get(params.workId),
    runGateRowSchema,
  );
  const gate = params.gate ?? "running";
  const statusOk =
    run !== undefined &&
    (gate === "running" ? run.status === "running" : CLEANUP_STATUSES.has(run.status));
  if (!statusOk) {
    return publishError("mutation_gate_failed", "Publish intent requires a running work run", {
      workId: params.workId,
      ...(params.operationKey !== undefined ? { operationKey: params.operationKey } : {}),
      status: run?.status ?? null,
      gate,
    });
  }
  if (
    gate === "running" &&
    params.laneEpoch != null &&
    (run.lane_epoch !== params.laneEpoch ||
      !laneEpochHeld(db, params.prKey, run.lane, params.laneEpoch))
  ) {
    return publishError("mutation_gate_failed", "Publish intent lane epoch is no longer current", {
      workId: params.workId,
      ...(params.operationKey !== undefined ? { operationKey: params.operationKey } : {}),
    });
  }
  return ((pinnedReturn: AppError | undefined) => pinnedReturn)(undefined);
}

function assertRunGate(db: DatabaseSync, params: RunGate) {
  const failure = runGateFailure(db, params);
  if (failure !== undefined) throw failure;
  if (params.shutdownRequested?.() === true) {
    throw publishError("mutation_gate_failed", "Publish intent blocked during shutdown", {
      workId: params.workId,
      ...(params.operationKey !== undefined ? { operationKey: params.operationKey } : {}),
    });
  }
}

function assertReservedReady(db: DatabaseSync, params: PublishOnceParams<unknown>) {
  assertRunGate(db, params);
  const intentKey = intentKeyFor(params.workId, params.operationKey);
  const conflict = readRow(
    db
      .prepare(
        `SELECT intent_key, state FROM publish_intents
          WHERE pr_key = ? AND resource_target = ? AND intent_key != ?
            AND substr(?, 1, length(intent_key) + 9) != intent_key || ':surface:'
            AND (state = 'mutating'
              OR (state = 'outcome_unknown_recoverable'
                  AND json_extract(identity_json, '$.blocksOverwrite') = 1))
          LIMIT 1`,
      )
      .get(params.prKey, params.resourceTarget, intentKey, intentKey),
    conflictRowSchema,
  );
  if (conflict !== undefined) {
    throw publishError(
      "mutation_conflict",
      conflict.state === "mutating"
        ? "A conflicting publish intent is in flight for this resource"
        : "An unresolved overwrite-sensitive publish intent blocks this resource",
      {
        workId: params.workId,
        operationKey: params.operationKey,
        resourceTarget: params.resourceTarget,
        conflictingIntent: conflict.intent_key,
        conflictingState: conflict.state,
      },
    );
  }
}

type PublishAction =
  | { readonly kind: "cached"; readonly intent: PublishIntentRow }
  | { readonly kind: "terminal"; readonly intent: PublishIntentRow }
  | { readonly kind: "lookup"; readonly intent: PublishIntentRow }
  | { readonly kind: "send"; readonly intent: PublishIntentRow };

function decidePublishAction(db: DatabaseSync, params: PublishOnceParams<unknown>, now: number) {
  return immediate(db, () => {
    const intentKey = intentKeyFor(params.workId, params.operationKey);
    const existing = intentByKey(db, intentKey);
    if (existing !== undefined) {
      switch (existing.state) {
        case "reconciled":
          return ((pinnedReturn: PublishAction) => pinnedReturn)({
            kind: "cached",
            intent: existing,
          });
        case "outcome_unknown_terminal":
          return ((pinnedReturn: PublishAction) => pinnedReturn)({
            kind: "terminal",
            intent: existing,
          });
        case "outcome_unknown_recoverable":
        case "mutating":
          return ((pinnedReturn: PublishAction) => pinnedReturn)({
            kind: "lookup",
            intent: existing,
          });
        case "reserved":
        case "mutation_failed":
          break;
        default: {
          const exhaustive: never = existing.state;
          throw new Error(`unhandled publish intent state ${String(exhaustive)}`);
        }
      }
      assertReservedReady(db, params);
      db.prepare(
        `UPDATE publish_intents SET state = 'mutating', resource_target = ?, updated_at = ?
          WHERE intent_key = ?`,
      ).run(params.resourceTarget, now, intentKey);
      return ((pinnedReturn: PublishAction) => pinnedReturn)({
        kind: "send",
        intent: { ...existing, state: "mutating", updated_at: now },
      });
    }
    assertReservedReady(db, params);
    db.prepare(
      `INSERT INTO publish_intents
        (intent_key, pr_key, work_id, resource_target, operation_key, state, mutation_kind, identity_json, updated_at)
       VALUES (?, ?, ?, ?, ?, 'mutating', ?, ?, ?)`,
    ).run(
      intentKey,
      params.prKey,
      params.workId,
      params.resourceTarget,
      params.operationKey,
      params.mutationKind,
      JSON.stringify({
        ...params.identity,
        ...(params.blocksOverwrite === true ? { blocksOverwrite: true } : {}),
        ...(params.failClosed === true ? { failClosed: true } : {}),
      }),
      now,
    );
    const created = intentByKey(db, intentKey);
    if (created === undefined) {
      throw publishError("persist_no_row", "Publish intent insert produced no row", {
        workId: params.workId,
        operationKey: params.operationKey,
      });
    }
    return ((pinnedReturn: PublishAction) => pinnedReturn)({ kind: "send", intent: created });
  });
}

function applyReconciledSideEffects(
  db: DatabaseSync,
  params: PublishOnceParams<unknown>,
  value: unknown,
  now: number,
) {
  for (const record of params.publishRecordKeys ?? []) {
    db.prepare(
      `INSERT INTO publish_records (record_key, pr_key, work_id, step, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (record_key) DO NOTHING`,
    ).run(record.recordKey, params.prKey, params.workId, record.step, record.payloadJson, now);
  }
  if (params.verdictRetentionJson !== undefined) {
    db.prepare(
      `UPDATE pr_state SET selected_verdict_json = COALESCE(selected_verdict_json, ?), updated_at = ?
        WHERE pr_key = ?`,
    ).run(params.verdictRetentionJson, now, params.prKey);
  }
  params.onReconciled?.(db, value, now);
}

function commitIntentState(
  db: DatabaseSync,
  params: PublishOnceParams<unknown>,
  state: PublishIntentState,
  resultJson: string | null,
  now: number,
  value?: unknown,
) {
  const failure = immediate(db, () => {
    const lostGate = state === "reconciled" ? runGateFailure(db, params) : undefined;
    const next = lostGate === undefined ? state : "outcome_unknown_terminal";
    db.prepare(
      `UPDATE publish_intents SET state = ?, result_json = ?, updated_at = ? WHERE intent_key = ?`,
    ).run(
      next,
      lostGate === undefined ? resultJson : null,
      now,
      intentKeyFor(params.workId, params.operationKey),
    );
    if (next === "reconciled") applyReconciledSideEffects(db, params, value, now);
    return lostGate;
  });
  if (failure !== undefined)
    throw unknownOutcome(
      params,
      true,
      failure,
      "Publish gate lost after mutation; remutate forbidden",
    );
}

async function lookupWithRetries(params: PublishOnceParams<unknown>, intent: PublishIntentRow) {
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < LOOKUP_RETRIES; attempt += 1) {
    if (params.recover === undefined) break;
    let recovered: PublishRecovery;
    try {
      recovered = await params.recover(intent);
    } catch (error) {
      throw publishError(
        "recovery_failed",
        "Failed to reconcile an outcome-unknown GitHub mutation",
        {
          workId: params.workId,
          operationKey: params.operationKey,
          mutationKind: params.mutationKind,
        },
        error,
      );
    }
    if (recovered.found) return recovered;
    if (attempt < LOOKUP_RETRIES - 1) await sleep(LOOKUP_BACKOFF_MS[attempt] ?? 1000);
  }
  return ((pinnedReturn: PublishRecovery) => pinnedReturn)({ found: false });
}

function decodeValue(params: PublishOnceParams<unknown>, value: unknown) {
  if (params.decodeResult === undefined) return ((pinnedReturn: unknown) => pinnedReturn)(value);
  try {
    return ((pinnedReturn: unknown) => pinnedReturn)(params.decodeResult(value));
  } catch (error) {
    throw publishError(
      "mutation_outcome_unknown",
      "Mutation result failed validation; remutate forbidden",
      {
        workId: params.workId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
        unknownResolution: "terminal",
      },
      error,
    );
  }
}

function finishPublish(params: PublishOnceParams<unknown>, value: unknown, now: number) {
  const decoded = decodeValue(params, value);
  commitIntentState(
    params.db,
    params,
    "reconciled",
    JSON.stringify(value === undefined ? null : value),
    now,
    decoded,
  );
  return ((pinnedReturn: unknown) => pinnedReturn)(decoded);
}

function unknownOutcome(
  params: PublishOnceParams<unknown>,
  terminal: boolean,
  cause?: unknown,
  message = UNKNOWN_MUTATION_MESSAGE,
) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    publishError(
      "mutation_outcome_unknown",
      message,
      {
        workId: params.workId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
        ...(terminal ? { unknownResolution: "terminal" } : {}),
      },
      cause,
    ),
  );
}

export function publishOnce<T>(
  requested: PublishOnceParams<T> & {
    readonly decodeResult: (value: unknown) => T;
  },
): Promise<T>;
export function publishOnce(requested: PublishOnceParams<unknown>): Promise<unknown>;
export async function publishOnce(requested: PublishOnceParams<unknown>) {
  const params: PublishOnceParams<unknown> = requested;
  const nowOf = () => params.now ?? Date.now();
  throwIfAborted(params.signal, {
    message: "PR-surface mutation was aborted before completion",
    context: { workId: params.workId, operationKey: params.operationKey },
  });
  const action = decidePublishAction(params.db, params, nowOf());

  if (action.kind === "cached") {
    const parsed = intentResult(action.intent);
    const stored = parsed === null ? undefined : parsed;
    if (stored !== undefined || params.allowsUndefinedResult === true) {
      return ((pinnedReturn: unknown) => pinnedReturn)(decodeValue(params, stored));
    }
    throw publishError("mutation_outcome_unknown", RECONCILED_REMUTATE_MESSAGE, {
      workId: params.workId,
      operationKey: params.operationKey,
      mutationKind: params.mutationKind,
      unknownResolution: "terminal",
    });
  }

  if (action.kind === "terminal") throw unknownOutcome(params, true);

  if (action.kind === "lookup") {
    const recovered = await lookupWithRetries(params, action.intent);
    if (recovered.found)
      return ((pinnedReturn: unknown) => pinnedReturn)(
        finishPublish(params, recovered.value, nowOf()),
      );
    throw unknownOutcome(params, false);
  }

  let result: unknown;
  try {
    throwIfAborted(params.signal, {
      message: "PR-surface mutation was aborted before completion",
      context: { workId: params.workId, operationKey: params.operationKey },
    });
    result = await runInOperationIntentFrame(params.operationKey, () => params.mutate());
  } catch (error) {
    const knownNoAcceptance =
      params.isKnownNoAcceptanceError?.(error) ?? isKnownNoAcceptanceMutationError(error);
    if (knownNoAcceptance) {
      commitIntentState(params.db, params, "mutation_failed", null, nowOf());
      assertRunGate(params.db, params);
      throw error;
    }
    if (params.failClosed !== true && params.recover !== undefined) {
      const live = intentByKey(params.db, intentKeyFor(params.workId, params.operationKey));
      if (live !== undefined) {
        let recovered: PublishRecovery;
        try {
          recovered = await lookupWithRetries(params, live);
        } catch (recoveryError) {
          commitIntentState(params.db, params, "outcome_unknown_recoverable", null, nowOf());
          throw recoveryError;
        }
        if (recovered.found)
          return ((pinnedReturn: unknown) => pinnedReturn)(
            finishPublish(params, recovered.value, nowOf()),
          );
      }
    }
    commitIntentState(
      params.db,
      params,
      params.failClosed === true ? "outcome_unknown_terminal" : "outcome_unknown_recoverable",
      null,
      nowOf(),
    );
    throw unknownOutcome(params, params.failClosed === true, error);
  }

  return ((pinnedReturn: unknown) => pinnedReturn)(finishPublish(params, result, nowOf()));
}

export function sharedPublishRecordKey(resourceKey: string, lens: string, step: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`shared:${resourceKey}:${lens}:${step}`);
}

export function workPublishRecordKey(workId: string, step: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`workItem:${workId}:${step}`);
}

export function mutatingIntents(db: DatabaseSync) {
  return ((pinnedReturn: readonly PublishIntentRow[]) => pinnedReturn)(
    readRows(
      db.prepare(`SELECT * FROM publish_intents WHERE state = 'mutating'`).all(),
      publishIntentRowSchema,
    ),
  );
}

export function recoverableIntents(db: DatabaseSync) {
  return ((pinnedReturn: readonly PublishIntentRow[]) => pinnedReturn)(
    readRows(
      db.prepare(`SELECT * FROM publish_intents WHERE state = 'outcome_unknown_recoverable'`).all(),
      publishIntentRowSchema,
    ),
  );
}

const PUBLISH_STEP_SPECS = {
  progress_comment: { scope: "resource", merge: "progress" },
  inline_review: { scope: "resource", merge: "batches" },
  summary_comment: { scope: "resource", merge: "replace" },
  summary_comment_claim: { scope: "resource", merge: "replace" },
  standing_review: { scope: "resource", merge: "replace" },
  check_run: { scope: "work", merge: "merge" },
  labels: { scope: "resource", merge: "replace" },
  pr_body: { scope: "resource", merge: "replace" },
  ask_reply: { scope: "work", merge: "replace" },
  triage_push: { scope: "resource", merge: "replace" },
  triage_thread_actions: { scope: "resource", merge: "replace" },
  triage_report: { scope: "resource", merge: "replace" },
  triage_preview: { scope: "resource", merge: "replace" },
  verification_thread_actions: { scope: "resource", merge: "replace" },
  ci_cell: { scope: "resource", merge: "replace" },
  commit_status: { scope: "resource", merge: "replace" },
  verification_failure: { scope: "resource", merge: "replace" },
} as const satisfies Record<
  string,
  {
    readonly scope: "resource" | "work";
    readonly merge: "progress" | "batches" | "replace" | "merge";
  }
>;

export type PublishStep = keyof typeof PUBLISH_STEP_SPECS;

export type PublishRecord = {
  readonly recordKey: string;
  readonly workId: string;
  readonly step: string;
  readonly githubId: number | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: number;
};

const publishRecordRowSchema = v.object({
  record_key: v.string(),
  pr_key: v.string(),
  work_id: v.string(),
  step: v.string(),
  payload_json: v.string(),
  created_at: v.number(),
});

function githubIdOf(detail: Record<string, unknown>) {
  const raw = detail.githubId;
  const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return ((pinnedReturn: number | null) => pinnedReturn)(Number.isFinite(id) ? id : null);
}

function toPublishRecord(row: v.InferOutput<typeof publishRecordRowSchema>) {
  const parsed: unknown = JSON.parse(row.payload_json);
  const detail = isRecord(parsed) ? parsed : {};
  return ((pinnedReturn: PublishRecord) => pinnedReturn)({
    recordKey: row.record_key,
    workId: row.work_id,
    step: row.step,
    githubId: githubIdOf(detail),
    detail,
    createdAt: row.created_at,
  });
}

export function readPublishRecord(db: DatabaseSync, recordKey: string) {
  const row = readRow(
    db.prepare(`SELECT * FROM publish_records WHERE record_key = ?`).get(recordKey),
    publishRecordRowSchema,
  );
  return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(
    row === undefined ? undefined : toPublishRecord(row),
  );
}

export type PublishIdentity = {
  readonly db: DatabaseSync;
  readonly workId: string;
  readonly prKey: string;
  readonly reviewLens: string;
  readonly laneEpoch?: number | null;
  readonly shutdownRequested?: () => boolean;
  readonly gate?: PublishGate;
  readonly signal?: AbortSignal;
};

function batchIdOf(value: unknown) {
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    isRecord(value) && typeof value.batchId === "string" ? value.batchId : undefined,
  );
}

function mergeDetail(
  merge: "progress" | "batches" | "replace" | "merge",
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
) {
  if (previous === undefined || merge === "replace")
    return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(next);
  if (merge === "progress" || merge === "merge")
    return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({ ...previous, ...next });
  const existing = Array.isArray(previous.batches) ? previous.batches : [];
  const incoming = Array.isArray(next.batches) ? next.batches : [];
  const seen = new Set(existing.map(batchIdOf).filter((id) => id !== undefined));
  const merged = [...existing];
  for (const batch of incoming) {
    const id = batchIdOf(batch);
    if (id !== undefined && seen.has(id)) continue;
    if (id !== undefined) seen.add(id);
    merged.push(batch);
  }
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    ...previous,
    ...next,
    batches: merged,
  });
}

function upsertRecordRow(
  db: DatabaseSync,
  params: {
    readonly recordKey: string;
    readonly prKey: string;
    readonly workId: string;
    readonly step: string;
    readonly detail: Record<string, unknown>;
    readonly now: number;
  },
) {
  db.prepare(
    `INSERT INTO publish_records (record_key, pr_key, work_id, step, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (record_key) DO UPDATE SET work_id = excluded.work_id,
       payload_json = excluded.payload_json`,
  ).run(
    params.recordKey,
    params.prKey,
    params.workId,
    params.step,
    JSON.stringify(params.detail),
    params.now,
  );
}

export function writePublishStep(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly prKey: string;
    readonly reviewLens: string;
    readonly step: PublishStep;
    readonly githubId?: string | number | null;
    readonly detail?: Record<string, unknown>;
    readonly now?: number;
  },
) {
  const spec = PUBLISH_STEP_SPECS[params.step];
  const now = params.now ?? Date.now();
  const incoming: Record<string, unknown> = {
    ...params.detail,
    ...(params.githubId != null ? { githubId: Number(params.githubId) } : {}),
    reviewLens: params.reviewLens,
    updatedAt: now,
  };
  const workKey = workPublishRecordKey(params.workId, params.step);
  const sharedKey = sharedPublishRecordKey(params.prKey, params.reviewLens, params.step);
  immediate(db, () => {
    const ownRecord = readPublishRecord(db, workKey);
    upsertRecordRow(db, {
      recordKey: workKey,
      prKey: params.prKey,
      workId: params.workId,
      step: params.step,
      detail: mergeDetail(spec.merge, ownRecord?.detail, incoming),
      now,
    });
    if (spec.scope !== "resource") return;
    const shared = readPublishRecord(db, sharedKey);
    if (
      params.step === "progress_comment" &&
      shared !== undefined &&
      shared.workId !== params.workId
    ) {
      throw new AppError({
        domain: "agent_work",
        kind: "progress_comment_ownership_conflict",
        message: "Progress comment publish record was rejected by its ownership gate",
        context: {
          workItemId: params.workId,
          resourceKey: params.prKey,
          reviewLens: params.reviewLens,
          ownerWorkItemId: shared.workId,
        },
      });
    }
    upsertRecordRow(db, {
      recordKey: sharedKey,
      prKey: params.prKey,
      workId: params.workId,
      step: params.step,
      detail: mergeDetail(spec.merge, shared?.detail, incoming),
      now,
    });
  });
}

export function claimPublishStep(
  db: DatabaseSync,
  params: {
    readonly workId: string;
    readonly prKey: string;
    readonly reviewLens: string;
    readonly step: PublishStep;
    readonly detail?: Record<string, unknown>;
    readonly now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const sharedKey = sharedPublishRecordKey(params.prKey, params.reviewLens, params.step);
  return immediate(db, () => {
    const existing = readPublishRecord(db, sharedKey);
    if (existing !== undefined) return existing.workId === params.workId;
    upsertRecordRow(db, {
      recordKey: sharedKey,
      prKey: params.prKey,
      workId: params.workId,
      step: params.step,
      detail: { ...params.detail, reviewLens: params.reviewLens, updatedAt: now },
      now,
    });
    return true;
  });
}

export function sharedPublishRecord(
  db: DatabaseSync,
  prKey: string,
  reviewLens: string,
  step: PublishStep,
) {
  return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(
    readPublishRecord(db, sharedPublishRecordKey(prKey, reviewLens, step)),
  );
}

export function progressStubPostedAtMs(
  db: DatabaseSync,
  prKey: string,
  reviewLens: string,
  workItemId: string,
) {
  const record = sharedPublishRecord(db, prKey, reviewLens, "progress_comment");
  if (record === undefined || record.workId !== workItemId)
    return ((pinnedReturn: number | null) => pinnedReturn)(null);
  const stamped = record.detail?.["stubPostedAtMs"];
  return ((pinnedReturn: number | null) => pinnedReturn)(
    typeof stamped === "number" && Number.isFinite(stamped) ? stamped : null,
  );
}

export function workPublishRecord(db: DatabaseSync, workId: string, step: PublishStep) {
  return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(
    readPublishRecord(db, workPublishRecordKey(workId, step)),
  );
}

export function latestCommentGithubId(db: DatabaseSync, prKey: string, reviewLens: string) {
  const candidates = [
    sharedPublishRecord(db, prKey, reviewLens, "summary_comment"),
    sharedPublishRecord(db, prKey, reviewLens, "progress_comment"),
  ].filter((record): record is PublishRecord => record !== undefined && record.githubId != null);
  const newest = candidates.toSorted(
    (a, b) => Number(b.detail.updatedAt ?? 0) - Number(a.detail.updatedAt ?? 0),
  )[0];
  return ((pinnedReturn: number | null) => pinnedReturn)(newest?.githubId ?? null);
}

const selectedVerdictRowSchema = v.object({ selected_verdict_json: v.nullable(v.string()) });

export type RetainedVerdict = {
  readonly workId: string;
  readonly reviewLens: string;
  readonly verdict: Record<string, unknown>;
};

function parseRetainedVerdict(raw: string | null) {
  if (raw === null) return ((pinnedReturn: RetainedVerdict | undefined) => pinnedReturn)(undefined);
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.workId !== "string" ||
    typeof parsed.reviewLens !== "string" ||
    !isRecord(parsed.verdict)
  )
    return ((pinnedReturn: RetainedVerdict | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: RetainedVerdict | undefined) => pinnedReturn)({
    workId: parsed.workId,
    reviewLens: parsed.reviewLens,
    verdict: parsed.verdict,
  });
}

export function retainedVerdict(
  db: DatabaseSync,
  params: { readonly prKey: string; readonly workId: string; readonly reviewLens: string },
) {
  const row = readRow(
    db.prepare(`SELECT selected_verdict_json FROM pr_state WHERE pr_key = ?`).get(params.prKey),
    selectedVerdictRowSchema,
  );
  const retained = parseRetainedVerdict(row?.selected_verdict_json ?? null);
  if (
    retained === undefined ||
    retained.workId !== params.workId ||
    retained.reviewLens !== params.reviewLens
  )
    return ((pinnedReturn: RetainedVerdict | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: RetainedVerdict | undefined) => pinnedReturn)(retained);
}

export function retainFirstVerdict(
  db: DatabaseSync,
  params: {
    readonly prKey: string;
    readonly workId: string;
    readonly reviewLens: string;
    readonly verdict: Record<string, unknown>;
    readonly now?: number;
  },
) {
  const now = params.now ?? Date.now();
  return immediate(db, () => {
    db.prepare(
      `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, updated_at)
       VALUES (?, 'open', 0, ?) ON CONFLICT (pr_key) DO NOTHING`,
    ).run(params.prKey, now);
    const row = readRow(
      db.prepare(`SELECT selected_verdict_json FROM pr_state WHERE pr_key = ?`).get(params.prKey),
      selectedVerdictRowSchema,
    );
    const existing = parseRetainedVerdict(row?.selected_verdict_json ?? null);
    if (
      existing !== undefined &&
      existing.workId === params.workId &&
      existing.reviewLens === params.reviewLens
    ) {
      return ((pinnedReturn: RetainedVerdict) => pinnedReturn)(existing);
    }
    const next: RetainedVerdict = {
      workId: params.workId,
      reviewLens: params.reviewLens,
      verdict: params.verdict,
    };
    db.prepare(
      `UPDATE pr_state SET selected_verdict_json = ?, updated_at = ? WHERE pr_key = ?`,
    ).run(JSON.stringify(next), now, params.prKey);
    return ((pinnedReturn: RetainedVerdict) => pinnedReturn)(next);
  });
}

const OVERWRITE_SENSITIVE_METHODS: ReadonlySet<string> = new Set([
  "editComment",
  "editReviewComment",
  "upsertProgressComment",
  "setLabels",
  "setReviewCommitStatus",
  "publishDescription",
  "finishReviewCheck",
]);

const FAIL_CLOSED_METHODS: ReadonlySet<string> = new Set(["setLabels", "setReviewCommitStatus"]);

export function surfaceResourceTarget(detail: Record<string, unknown>) {
  const method = typeof detail.surfaceMethod === "string" ? detail.surfaceMethod : "unknown";
  const numberField = (key: string) => {
    const value = detail[key];
    return typeof value === "number" ? value : undefined;
  };
  const stringField = (key: string) => {
    const value = detail[key];
    return typeof value === "string" ? value : undefined;
  };
  switch (method) {
    case "editComment":
    case "editReviewComment": {
      const id = numberField("commentId");
      return ((pinnedReturn: string) => pinnedReturn)(
        id === undefined ? `${method}:unknown` : `comment:${id}`,
      );
    }
    case "upsertProgressComment": {
      const id = numberField("knownExistingId");
      return ((pinnedReturn: string) => pinnedReturn)(
        id === undefined ? `progress_comment:${stringField("sentinel") ?? ""}` : `comment:${id}`,
      );
    }
    case "setLabels":
      return ((pinnedReturn: string) => pinnedReturn)("labels");
    case "setReviewCommitStatus":
      return ((pinnedReturn: string) => pinnedReturn)("commit_status");
    case "startReviewCheck":
    case "finishReviewCheck":
      return ((pinnedReturn: string) => pinnedReturn)("check_run");
    case "publishDescription":
      return ((pinnedReturn: string) => pinnedReturn)("pr_body");
    case "resolveInlineReviewThread":
      return ((pinnedReturn: string) => pinnedReturn)(`thread:${stringField("threadId") ?? ""}`);
    case "dismissPullRequestReview":
      return ((pinnedReturn: string) => pinnedReturn)(`review:${numberField("reviewId") ?? 0}`);
    case "setAcknowledgementReaction":
      return ((pinnedReturn: string) => pinnedReturn)("reactions");
    default:
      return ((pinnedReturn: string) => pinnedReturn)(method);
  }
}

export function createPublishMutationBoundary(
  identity: Omit<PublishIdentity, "reviewLens"> & {
    readonly resolveIntentRecovery?: (
      mutation: PrSurfaceMutation,
      intent: PublishIntentRow,
    ) => Promise<OperationIntentRecovery<unknown>>;
  },
) {
  const signal = identity.signal ?? new AbortController().signal;
  return ((pinnedReturn: PrSurfaceMutationBoundary) => pinnedReturn)({
    signal,
    confirmLeaseHeld: async () => {
      assertRunGate(identity.db, {
        workId: identity.workId,
        prKey: identity.prKey,
        ...(identity.gate !== undefined ? { gate: identity.gate } : {}),
        ...(identity.laneEpoch !== undefined ? { laneEpoch: identity.laneEpoch } : {}),
        ...(identity.shutdownRequested !== undefined
          ? { shutdownRequested: identity.shutdownRequested }
          : {}),
      });
    },
    run: async (mutation, mutate) => {
      const detail = mutation.detail ?? {};
      const method = typeof detail.surfaceMethod === "string" ? detail.surfaceMethod : "";
      let mutationStarted = false;
      return publishOnce({
        db: identity.db,
        workId: identity.workId,
        prKey: identity.prKey,
        resourceTarget: surfaceResourceTarget(detail),
        operationKey: mutation.operationKey,
        mutationKind: mutation.mutationKind,
        identity: { ...detail, surfaceMutation: true },
        blocksOverwrite: OVERWRITE_SENSITIVE_METHODS.has(method),
        failClosed: FAIL_CLOSED_METHODS.has(method),
        ...(identity.gate !== undefined ? { gate: identity.gate } : {}),
        ...(identity.laneEpoch !== undefined ? { laneEpoch: identity.laneEpoch } : {}),
        ...(identity.shutdownRequested !== undefined
          ? { shutdownRequested: identity.shutdownRequested }
          : {}),
        signal,
        decodeResult: mutation.decodeResult,
        ...(mutation.allowsUndefinedResult === true ? { allowsUndefinedResult: true } : {}),
        isKnownNoAcceptanceError: (error) =>
          !mutationStarted || isKnownNoAcceptanceMutationError(error),
        ...(mutation.recover !== undefined
          ? {
              recover: async (intent: PublishIntentRow) => {
                const recovery =
                  identity.resolveIntentRecovery !== undefined
                    ? await identity.resolveIntentRecovery(mutation, intent)
                    : await (mutation.recover?.(toOperationIntentRow(intent), null) ??
                        Promise.resolve({ kind: "absent" as const }));
                return recovery.kind === "reconciled"
                  ? { found: true as const, value: recovery.value }
                  : { found: false as const };
              },
            }
          : {}),
        mutate: async () => {
          mutationStarted = true;
          return mutate();
        },
      });
    },
  });
}

export async function ensureRediscoveredSummaryComment(
  db: DatabaseSync,
  surface: PrSurface,
  params: {
    readonly workId: string;
    readonly prKey: string;
    readonly reviewLens: string;
    readonly sentinel: string;
  },
) {
  const known = latestCommentGithubId(db, params.prKey, params.reviewLens);
  if (known != null) return ((pinnedReturn: number | null) => pinnedReturn)(known);
  const found = await rediscoverBotArtifacts(surface, { sentinel: params.sentinel });
  if (found.summaryCommentId == null) return ((pinnedReturn: number | null) => pinnedReturn)(null);
  writePublishStep(db, {
    workId: params.workId,
    prKey: params.prKey,
    reviewLens: params.reviewLens,
    step: "summary_comment",
    githubId: found.summaryCommentId,
    detail: { rediscovered: true },
  });
  return ((pinnedReturn: number | null) => pinnedReturn)(found.summaryCommentId);
}

export async function ensureRediscoveredStandingReview(
  db: DatabaseSync,
  surface: PrSurface,
  params: {
    readonly workId: string;
    readonly prKey: string;
    readonly reviewLens: string;
    readonly headSha: string;
    readonly sentinel: string;
  },
) {
  const known = sharedPublishRecord(db, params.prKey, params.reviewLens, "standing_review");
  if (known !== undefined && known.detail.headSha === params.headSha)
    return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(known);
  const found = await rediscoverBotArtifacts(surface, {
    sentinel: params.sentinel,
    headSha: params.headSha,
  });
  if (found.standingReview === null)
    return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(undefined);
  writePublishStep(db, {
    workId: params.workId,
    prKey: params.prKey,
    reviewLens: params.reviewLens,
    step: "standing_review",
    githubId: found.standingReview.reviewId,
    detail: {
      headSha: params.headSha,
      state: found.standingReview.state,
      rediscovered: true,
    },
  });
  return ((pinnedReturn: PublishRecord | undefined) => pinnedReturn)(
    sharedPublishRecord(db, params.prKey, params.reviewLens, "standing_review"),
  );
}
