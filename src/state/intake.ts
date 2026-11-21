import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import {
  prResourceKey,
  type AckJobData,
  type AckTarget,
  type JobCorrelation,
  type PrRef,
  type ReplyTarget,
  type SlashCommandInput,
  type TriageMode,
  type WebhookHeaders,
} from "../agentWork/types.ts";
import type { ReviewAuthorTrust } from "../commands/slashAssociation.ts";
import { isReviewForceCommand, parseTriageCommand } from "../commands/parseSlashCommand.ts";
import { ASK_QUESTION_TOO_LONG_HINT, parseAskQuestion } from "../commands/parseAskQuestion.ts";
import { redactOutboundSecrets } from "../security/redactOutboundSecrets.ts";
import type { CiCheckFact } from "../review/ci/ciFacts.ts";
import type { WorkSource } from "../review/reviewSchema.ts";
import type { ReviewCancelAttribution, Features } from "../settings/index.ts";
import {
  ASK_THROTTLED_BODY,
  ASK_USAGE_HINT,
  DEFERRED_HEAD_SHA,
  DESCRIPTION_ALREADY_IN_PROGRESS,
  IGNORED_REVIEW_APPROVAL_MAINTAINER_REQUIRED,
  IGNORED_REVIEW_APPROVAL_NOT_AWAITING,
  MAX_STORED_COMMENT_TEXT_LEN,
  REVIEW_APPROVED,
  REVIEW_CANCELLED_PR_CLOSED,
  TRIAGE_ALREADY_IN_PROGRESS,
  TRIAGE_FULL_RUN_IN_PROGRESS,
  TRIAGE_INLINE_USAGE_HINT,
  TRIAGE_INVALID_EXCLUDE,
  TRIAGE_UNKNOWN_SUBCOMMAND,
  reviewCancelAttributionForClosedPr,
  reviewCancelLastError,
  sanitizeGithubLogin,
} from "../settings/index.ts";
import type { WideEventLevel } from "../evlog.ts";
import {
  applyPrHeadCiFactTx,
  headCiNeedsSeedForRow,
  isHeadCiSeedPullRequest,
  loadPrHeadCiState,
  shouldSeedHeadCiFromPullRequest,
} from "./prHeadCiState.ts";
import { insertWorkRun, cancelWorkRun, supersedeWorkRun, bumpLaneEpoch } from "./workRuns.ts";
import {
  releaseAskQuotaReservationTx,
  reserveAskQuotaTx,
  resolveAskQuotaConfig,
  type AskQuotaConfig,
  type AskQuotaRejectionReason,
} from "./askQuotas.ts";
import { sharedPublishRecordKey } from "./publish.ts";
import { immediate, readRow, readRows } from "./db.ts";

export type DeferredIntakeEvent = {
  readonly name: string;
  readonly fields?: Record<string, unknown>;
  readonly level?: WideEventLevel;
};

export type EventRecord =
  | { readonly id: string; readonly duplicate: false; readonly dedupeKey: string }
  | { readonly duplicate: true; readonly dedupeKey: string };

export type ReviewLifecycleObservation = {
  readonly state: "open" | "closed" | "merged";
  readonly observedAt: string | number;
};

export type AutomatedPullRequestIntakeOpts = {
  readonly authorTrust?: ReviewAuthorTrust;
  readonly pushBeforeSha?: string;
  readonly merged?: boolean;
  readonly lifecycle?: ReviewLifecycleObservation;
};

export type ReviewApprovalSignal =
  | { readonly kind: "pull_request_review"; readonly ref: PrRef }
  | {
      readonly kind: "workflow_run";
      readonly installationId: number;
      readonly owner: string;
      readonly repo: string;
      readonly headSha: string;
      readonly prNumbers: readonly number[];
    };

export type CiStateFactInput = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly fact: CiCheckFact;
};

export type IntakeCommand =
  | { readonly kind: "ignored"; readonly headers: WebhookHeaders; readonly decision: string }
  | {
      readonly kind: "pull_request";
      readonly headers: WebhookHeaders;
      readonly ref: PrRef;
      readonly action: string;
      readonly opts?: AutomatedPullRequestIntakeOpts;
    }
  | {
      readonly kind: "review_approved";
      readonly headers: WebhookHeaders;
      readonly signal: ReviewApprovalSignal;
    }
  | {
      readonly kind: "ci_refresh";
      readonly headers: WebhookHeaders;
      readonly data: {
        readonly installationId: number;
        readonly owner: string;
        readonly repo: string;
        readonly headSha: string;
        readonly prNumbers: readonly number[];
      };
    }
  | { readonly kind: "ci_state"; readonly headers: WebhookHeaders; readonly data: CiStateFactInput }
  | { readonly kind: "slash"; readonly input: SlashCommandInput }
  | {
      readonly kind: "verification_reply";
      readonly headers: WebhookHeaders;
      readonly installationId: number;
      readonly owner: string;
      readonly repo: string;
      readonly prNumber: number;
      readonly repositorySizeKb?: number;
    };

export type IntakeFeatures = Pick<
  Features,
  "review" | "reviewCadence" | "describe" | "verification" | "ask" | "triage"
>;

export type DeliveryResult = {
  readonly events: readonly DeferredIntakeEvent[];
  readonly conversationsToAbort: readonly string[];
};

function webhookEventKeys(headers: WebhookHeaders) {
  const bodySha256 = createHash("sha256").update(headers.rawBody).digest("hex");
  return ((pinnedReturn: {
    readonly dedupeKey: string;
    readonly bodyDedupeKey: string;
    readonly bodySha256: string;
  }) => pinnedReturn)({
    dedupeKey: headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha256}`,
    bodyDedupeKey: `body:${bodySha256}`,
    bodySha256,
  });
}

function recordWebhookRejection(
  db: DatabaseSync,
  headers: WebhookHeaders,
  bodySha256: string,
  dedupeKey: string,
  reason: "delivery_key" | "body_key" | "body_replay",
  now: number,
) {
  db.prepare(
    `INSERT INTO webhook_rejections (delivery_key, metadata_json, created_at)
     VALUES (?, ?, ?)`,
  ).run(
    dedupeKey,
    JSON.stringify({
      deliveryId: headers.delivery ?? null,
      event: headers.event ?? "",
      bodySha256,
      reason,
    }),
    now,
  );
}

export function insertWebhookEvent(
  db: DatabaseSync,
  headers: WebhookHeaders,
  decision: string,
  now = Date.now(),
) {
  const keys = webhookEventKeys(headers);
  const existing = readRow(
    db
      .prepare(`SELECT delivery_key FROM webhook_deliveries WHERE delivery_key = ?`)
      .get(keys.dedupeKey),
    v.object({ delivery_key: v.optional(v.string()) }),
  );
  if (existing !== undefined) {
    recordWebhookRejection(
      db,
      headers,
      keys.bodySha256,
      keys.dedupeKey,
      headers.delivery ? "delivery_key" : "body_key",
      now,
    );
    return ((pinnedReturn: EventRecord) => pinnedReturn)({
      duplicate: true,
      dedupeKey: keys.dedupeKey,
    });
  }

  const replay = readRow(
    db
      .prepare(`SELECT body_hash FROM webhook_body_replays WHERE body_hash = ?`)
      .get(keys.bodySha256),
    v.object({ body_hash: v.optional(v.string()) }),
  );
  if (replay !== undefined) {
    recordWebhookRejection(db, headers, keys.bodySha256, keys.bodyDedupeKey, "body_replay", now);
    return ((pinnedReturn: EventRecord) => pinnedReturn)({
      duplicate: true,
      dedupeKey: keys.bodyDedupeKey,
    });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO webhook_deliveries (delivery_key, body_hash, status, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(keys.dedupeKey, keys.bodySha256, decision, now);
  db.prepare(
    `INSERT INTO webhook_body_replays (body_hash, delivery_key, created_at)
     VALUES (?, ?, ?)`,
  ).run(keys.bodySha256, keys.dedupeKey, now);
  return ((pinnedReturn: EventRecord) => pinnedReturn)({
    id,
    duplicate: false,
    dedupeKey: keys.dedupeKey,
  });
}

export function jobCorrelation(eventId: string, headers: Pick<WebhookHeaders, "delivery">) {
  return ((pinnedReturn: JobCorrelation) => pinnedReturn)({
    webhookEventId: eventId,
    delivery: headers.delivery,
  });
}

const prStateRowSchema = v.object({
  pr_key: v.string(),
  lifecycle_state: v.string(),
  observed_at: v.number(),
  active_review_work_id: v.nullable(v.string()),
  active_review_source: v.nullable(v.string()),
  auto_review_epoch: v.number(),
  description_epoch: v.number(),
  verification_epoch: v.number(),
  triage_epoch: v.number(),
  approval_json: v.nullable(v.string()),
});
type PrStateRow = v.InferOutput<typeof prStateRowSchema>;

const workIdRowSchema = v.object({ work_id: v.optional(v.string()) });
const activeRunRowSchema = v.object({
  work_id: v.string(),
  status: v.string(),
  payload_json: v.string(),
});

const looseObjectSchema = v.looseObject({});

function parsePayloadObject(payloadJson: string) {
  const parsed = v.safeParse(looseObjectSchema, JSON.parse(payloadJson));
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

const ackTargetSchema = v.variant("kind", [
  v.looseObject({ kind: v.literal("pr"), prNumber: v.number() }),
  v.looseObject({ kind: v.literal("issueComment"), commentId: v.number() }),
  v.looseObject({ kind: v.literal("reviewComment"), commentId: v.number() }),
]);

function ackTargetsOf(value: unknown) {
  const parsed = v.safeParse(v.array(ackTargetSchema), value);
  return ((pinnedReturn: readonly AckTarget[] | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

const replyTargetSchema = v.variant("kind", [
  v.looseObject({ kind: v.literal("prConversation"), prNumber: v.number() }),
  v.looseObject({
    kind: v.literal("inlineReviewThread"),
    prNumber: v.number(),
    inReplyToCommentId: v.number(),
  }),
]);

function replyTargetOf(value: unknown) {
  const parsed = v.safeParse(replyTargetSchema, value);
  return ((pinnedReturn: ReplyTarget | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

const approvalDocSchema = v.object({
  state: v.picklist(["awaiting", "approved", "withdrawn"]),
  headSha: v.string(),
  workflowStartAdmits: v.boolean(),
  webhookEventId: v.optional(v.string()),
  approvedBy: v.optional(v.string()),
});
export type ApprovalDoc = v.InferOutput<typeof approvalDocSchema>;

export function ensurePrState(db: DatabaseSync, prKey: string, now: number) {
  db.prepare(
    `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, updated_at)
     VALUES (?, 'open', 0, ?) ON CONFLICT (pr_key) DO NOTHING`,
  ).run(prKey, now);
}

function loadPrState(db: DatabaseSync, prKey: string) {
  return ((pinnedReturn: PrStateRow | undefined) => pinnedReturn)(
    readRow(db.prepare(`SELECT * FROM pr_state WHERE pr_key = ?`).get(prKey), prStateRowSchema),
  );
}

function observedAtMs(observedAt: string | number) {
  return ((pinnedReturn: number) => pinnedReturn)(
    typeof observedAt === "string" ? Date.parse(observedAt) : observedAt,
  );
}

export function lifecycleObservationAccepted(
  existing: { readonly state: string; readonly observedAt: number } | undefined,
  observation: { readonly state: string; readonly observedAt: number },
) {
  if (existing === undefined) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (existing.state === "merged") return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (observation.observedAt > existing.observedAt)
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (observation.observedAt === existing.observedAt)
    return ((pinnedReturn: boolean) => pinnedReturn)(
      observation.state === "merged" ||
        (observation.state === "closed" && existing.state === "open"),
    );
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}

function recordLifecycleObservation(
  db: DatabaseSync,
  prKey: string,
  observation: { readonly state: string; readonly observedAt: number },
  now: number,
) {
  ensurePrState(db, prKey, now);
  const existing = loadPrState(db, prKey);
  if (
    existing !== undefined &&
    !lifecycleObservationAccepted(
      { state: existing.lifecycle_state, observedAt: existing.observed_at },
      observation,
    )
  )
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  db.prepare(
    `UPDATE pr_state SET lifecycle_state = ?, observed_at = ?, updated_at = ? WHERE pr_key = ?`,
  ).run(observation.state, observation.observedAt, now, prKey);
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

function loadApproval(db: DatabaseSync, row: PrStateRow | undefined) {
  if (row?.approval_json == null)
    return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(
    v.parse(approvalDocSchema, JSON.parse(row.approval_json)),
  );
}

function writeApproval(db: DatabaseSync, prKey: string, approval: ApprovalDoc, now: number) {
  db.prepare(`UPDATE pr_state SET approval_json = ?, updated_at = ? WHERE pr_key = ?`).run(
    JSON.stringify(approval),
    now,
    prKey,
  );
}

function reviewWorkRunExists(db: DatabaseSync, prKey: string) {
  const row = readRow(
    db
      .prepare(`SELECT work_id FROM work_runs WHERE pr_key = ? AND kind = 'review' LIMIT 1`)
      .get(prKey),
    workIdRowSchema,
  );
  return ((pinnedReturn: boolean) => pinnedReturn)(row !== undefined);
}

function insertAwaitingApproval(
  db: DatabaseSync,
  ref: PrRef,
  eventId: string,
  workflowStartAdmits: boolean,
  now: number,
) {
  const prKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  ensurePrState(db, prKey, now);
  const row = loadPrState(db, prKey);
  if (row === undefined || row.approval_json != null || reviewWorkRunExists(db, prKey))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  writeApproval(
    db,
    prKey,
    {
      state: "awaiting",
      headSha: ref.headSha,
      workflowStartAdmits,
      webhookEventId: eventId,
    },
    now,
  );
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

function loadAwaitingApproval(db: DatabaseSync, prKey: string, headSha?: string) {
  const approval = loadApproval(db, loadPrState(db, prKey));
  if (approval === undefined || approval.state !== "awaiting")
    return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(undefined);
  if (headSha !== undefined && approval.headSha !== headSha)
    return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(approval);
}

function approveAwaiting(
  db: DatabaseSync,
  prKey: string,
  by: "workflow_run" | "pull_request_review" | "slash",
  headSha: string | undefined,
  now: number,
) {
  const approval = loadAwaitingApproval(db, prKey, headSha);
  if (approval === undefined)
    return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(undefined);
  if (by === "workflow_run" && !approval.workflowStartAdmits)
    return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(undefined);
  const next: ApprovalDoc = { ...approval, state: "approved", approvedBy: by };
  writeApproval(db, prKey, next, now);
  return ((pinnedReturn: ApprovalDoc | undefined) => pinnedReturn)(next);
}

function moveAwaitingHead(db: DatabaseSync, prKey: string, headSha: string, now: number) {
  const approval = loadAwaitingApproval(db, prKey);
  if (approval === undefined) return;
  writeApproval(db, prKey, { ...approval, headSha }, now);
}

function withdrawAwaiting(db: DatabaseSync, prKey: string, now: number) {
  const approval = loadAwaitingApproval(db, prKey);
  if (approval === undefined) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  writeApproval(db, prKey, { ...approval, state: "withdrawn" }, now);
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

function reviewPushAdmitted(db: DatabaseSync, prKey: string) {
  if (reviewWorkRunExists(db, prKey)) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  const approval = loadApproval(db, loadPrState(db, prKey));
  return ((pinnedReturn: boolean) => pinnedReturn)(approval?.state === "approved");
}

function findAwaitingForHead(db: DatabaseSync, owner: string, repo: string, headSha: string) {
  const rows = readRows(
    db
      .prepare(
        `SELECT pr_key, approval_json FROM pr_state
         WHERE pr_key LIKE ? AND approval_json IS NOT NULL`,
      )
      .all(`${owner}/${repo}#%`),
    v.object({ pr_key: v.string(), approval_json: v.nullable(v.string()) }),
  );
  const matches: { readonly prKey: string; readonly prNumber: number }[] = [];
  for (const row of rows) {
    if (row.approval_json == null) continue;
    const approval = v.parse(approvalDocSchema, JSON.parse(row.approval_json));
    if (approval.state !== "awaiting" || approval.headSha !== headSha) continue;
    const prNumber = Number(row.pr_key.slice(row.pr_key.lastIndexOf("#") + 1));
    if (!Number.isInteger(prNumber)) continue;
    matches.push({ prKey: row.pr_key, prNumber });
  }
  return ((pinnedReturn: readonly { readonly prKey: string; readonly prNumber: number }[]) =>
    pinnedReturn)(matches);
}

function setActiveReview(
  db: DatabaseSync,
  prKey: string,
  workId: string,
  source: WorkSource,
  now: number,
) {
  ensurePrState(db, prKey, now);
  db.prepare(
    `UPDATE pr_state SET active_review_work_id = ?, active_review_source = ?, updated_at = ?
     WHERE pr_key = ?`,
  ).run(workId, source, now, prKey);
}

function clearActiveReview(
  db: DatabaseSync,
  prKey: string,
  workIds: readonly string[],
  now: number,
) {
  if (workIds.length === 0) return;
  const row = loadPrState(db, prKey);
  if (row?.active_review_work_id == null || !workIds.includes(row.active_review_work_id)) return;
  db.prepare(
    `UPDATE pr_state SET active_review_work_id = NULL, active_review_source = NULL, updated_at = ?
     WHERE pr_key = ?`,
  ).run(now, prKey);
}

const ACTIVE_RUN_STATUSES = "('pending_dispatch', 'retry_scheduled', 'running')";
const SLASH_RUN_PREDICATE = `json_extract(payload_json, '$.source') = 'slash'
   AND COALESCE(json_extract(payload_json, '$.staleHeadRescheduled'), 0) <> 1`;
const AUTO_RUN_PREDICATE = `json_extract(payload_json, '$.source') = 'auto'`;

function activeAutoRuns(db: DatabaseSync, prKey: string, kind: string) {
  return ((pinnedReturn: readonly { readonly workId: string; readonly payloadJson: string }[]) =>
    pinnedReturn)(
    readRows(
      db
        .prepare(
          `SELECT work_id, 'active' AS status, payload_json FROM work_runs
           WHERE pr_key = ? AND kind = ? AND status IN ${ACTIVE_RUN_STATUSES} AND ${AUTO_RUN_PREDICATE}`,
        )
        .all(prKey, kind),
      activeRunRowSchema,
    ).map((row) => ({ workId: row.work_id, payloadJson: row.payload_json })),
  );
}

type ActiveSlashRun = {
  readonly workId: string;
  readonly status: string;
  readonly hasFollowUp: boolean;
  readonly followUpReplacementId: string | null;
};

function activeSlashRuns(db: DatabaseSync, prKey: string, kind: string) {
  return ((pinnedReturn: readonly ActiveSlashRun[]) => pinnedReturn)(
    readRows(
      db
        .prepare(
          `SELECT work_id, status, payload_json FROM work_runs
           WHERE pr_key = ? AND kind = ? AND status IN ${ACTIVE_RUN_STATUSES}
             AND ${SLASH_RUN_PREDICATE}`,
        )
        .all(prKey, kind),
      activeRunRowSchema,
    ).map((row) => {
      const payload = parsePayloadObject(row.payload_json);
      const followUpParsed = v.safeParse(
        v.looseObject({ replacementWorkItemId: v.optional(v.unknown()) }),
        payload?.pushFollowUp,
      );
      const replacementId = followUpParsed.success
        ? followUpParsed.output.replacementWorkItemId
        : undefined;
      return {
        workId: row.work_id,
        status: row.status,
        hasFollowUp: payload?.pushFollowUp !== undefined,
        followUpReplacementId: typeof replacementId === "string" ? replacementId : null,
      };
    }),
  );
}

export type CancelledRun = {
  readonly workId: string;
  readonly headSha: string;
  readonly source: string;
  readonly ackTargets?: readonly AckTarget[];
  readonly replyTarget?: ReplyTarget;
  readonly conversationId?: string;
};

function cancelActiveRunsOfKind(
  db: DatabaseSync,
  prKey: string,
  kind: "review" | "triage",
  attribution: ReviewCancelAttribution,
  prNumber: number | undefined,
  now: number,
) {
  const rows = readRows(
    db
      .prepare(
        `SELECT work_id, status, payload_json FROM work_runs
         WHERE pr_key = ? AND kind = ? AND status IN ${ACTIVE_RUN_STATUSES}`,
      )
      .all(prKey, kind),
    activeRunRowSchema,
  );
  const cancelled: CancelledRun[] = [];
  for (const row of rows) {
    const record = parsePayloadObject(row.payload_json) ?? {};
    const conversationId = cancelWorkRun(db, {
      workId: row.work_id,
      reason: reviewCancelLastError(attribution),
      now,
    });
    cancelled.push({
      workId: row.work_id,
      headSha: typeof record.headSha === "string" ? record.headSha : "",
      source: typeof record.source === "string" ? record.source : "auto",
      ackTargets: ackTargetsOf(record.ackTargets),
      replyTarget: replyTargetOf(record.replyTarget),
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
  }
  if (kind === "review") {
    clearActiveReview(
      db,
      prKey,
      cancelled.map((row) => row.workId),
      now,
    );
  }
  void prNumber;
  return ((pinnedReturn: readonly CancelledRun[]) => pinnedReturn)(cancelled);
}

function supersedeAutoRuns(
  db: DatabaseSync,
  prKey: string,
  kind: "review" | "description" | "verification" | "triage",
  options: { readonly preserveQueuedIds?: readonly string[] },
  now: number,
) {
  const preserve = options.preserveQueuedIds ?? [];
  const runs = activeAutoRuns(db, prKey, kind).filter(
    (run) =>
      !(preserve.length > 0 && preserve.includes(run.workId) && runIsQueuedOnly(db, run.workId)),
  );
  const supersededIds: string[] = [];
  const conversationIds: string[] = [];
  for (const run of runs) {
    const conversationId = supersedeWorkRun(db, { workId: run.workId, now });
    supersededIds.push(run.workId);
    if (conversationId !== undefined) conversationIds.push(conversationId);
  }
  return ((pinnedReturn: {
    readonly supersededIds: readonly string[];
    readonly conversationIds: readonly string[];
  }) => pinnedReturn)({ supersededIds, conversationIds });
}

function runIsQueuedOnly(db: DatabaseSync, workId: string) {
  const row = readRow(
    db.prepare(`SELECT status FROM work_runs WHERE work_id = ?`).get(workId),
    v.object({ status: v.optional(v.string()) }),
  );
  return ((pinnedReturn: boolean) => pinnedReturn)(
    row?.status === "pending_dispatch" || row?.status === "retry_scheduled",
  );
}

function linkSupersededRuns(db: DatabaseSync, workId: string, supersededIds: readonly string[]) {
  for (const supersededId of supersededIds) {
    db.prepare(
      `UPDATE work_runs SET payload_json = json_set(payload_json, '$.supersededBy', ?)
       WHERE work_id = ?`,
    ).run(workId, supersededId);
  }
}

function runPayload(
  ref: PrRef,
  source: WorkSource,
  eventId: string,
  headers: WebhookHeaders,
  now: number,
  extra: Record<string, unknown>,
) {
  return ((pinnedReturn: string) => pinnedReturn)(
    JSON.stringify({
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      headSha: ref.headSha,
      source,
      webhookEventId: eventId,
      delivery: headers.delivery,
      webhookReceivedAt: now,
      ...extra,
    }),
  );
}

function insertAckRun(
  db: DatabaseSync,
  data: AckJobData & { readonly webhookReceivedAt: number },
  options?: { readonly workId?: string; readonly now: number },
) {
  const workId = options?.workId ?? randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO work_runs
      (work_id, pr_key, kind, lane, lane_epoch, status, current_attempt_no, payload_json, created_at, updated_at)
     VALUES (?, ?, 'ack', 'none', 0, 'pending_dispatch', 0, ?, ?, ?)`,
  ).run(
    workId,
    prResourceKey(data.owner, data.repo, data.prNumber),
    JSON.stringify(data),
    options?.now ?? Date.now(),
    options?.now ?? Date.now(),
  );
  return ((pinnedReturn: string) => pinnedReturn)(workId);
}

function insertCiProjectionRun(
  db: DatabaseSync,
  input: {
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly correlation: JobCorrelation;
    readonly prNumbers?: readonly number[];
  },
  now: number,
) {
  const existing = readRow(
    db
      .prepare(
        `SELECT work_id, 'active' AS status, payload_json FROM work_runs
         WHERE kind = 'ci_projection' AND status IN ${ACTIVE_RUN_STATUSES}
           AND json_extract(payload_json, '$.owner') = ?
           AND json_extract(payload_json, '$.repo') = ?
           AND json_extract(payload_json, '$.headSha') = ?`,
      )
      .get(input.owner, input.repo, input.headSha),
    activeRunRowSchema,
  );
  if (existing !== undefined) {
    const record = parsePayloadObject(existing.payload_json) ?? {};
    const correlations = Array.isArray(record.correlations) ? record.correlations : [];
    const existingCorrelation = {
      ...(record.webhookEventId != null ? { webhookEventId: record.webhookEventId } : {}),
      ...(record.delivery != null ? { delivery: record.delivery } : {}),
    };
    const merged = new Map<string, unknown>();
    for (const correlation of [existingCorrelation, ...correlations, input.correlation]) {
      const key = JSON.stringify(correlation);
      if (key !== "{}") merged.set(key, correlation);
    }
    const prNumbers = new Set<number>();
    if (Array.isArray(record.prNumbers)) {
      for (const value of record.prNumbers) if (typeof value === "number") prNumbers.add(value);
    }
    if (input.prNumbers) for (const value of input.prNumbers) prNumbers.add(value);
    db.prepare(`UPDATE work_runs SET payload_json = ?, updated_at = ? WHERE work_id = ?`).run(
      JSON.stringify({
        ...record,
        correlations: [...merged.values()],
        ...(prNumbers.size > 0 ? { prNumbers: [...prNumbers] } : {}),
      }),
      now,
      existing.work_id,
    );
    return ((pinnedReturn: { readonly workId: string; readonly merged: true }) => pinnedReturn)({
      workId: existing.work_id,
      merged: true,
    });
  }
  const workId = randomUUID();
  insertWorkRun(db, {
    workId,
    prKey: `${input.owner}/${input.repo}#${input.headSha}`,
    kind: "ci_projection",
    payloadJson: JSON.stringify({
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      headSha: input.headSha,
      ...(input.prNumbers !== undefined ? { prNumbers: input.prNumbers } : {}),
      webhookEventId: input.correlation.webhookEventId,
      delivery: input.correlation.delivery,
      webhookReceivedAt: now,
    }),
    now,
  });
  return ((pinnedReturn: { readonly workId: string; readonly merged: false }) => pinnedReturn)({
    workId,
    merged: false,
  });
}

function transferProgressCommentOwnership(
  db: DatabaseSync,
  params: { readonly workItemId: string; readonly resourceKey: string; readonly now: number },
) {
  db.prepare(
    `INSERT INTO publish_records (record_key, pr_key, work_id, step, payload_json, created_at)
     VALUES (?, ?, ?, 'progress_comment', '{"progressGeneration":0}', ?)
     ON CONFLICT (record_key) DO UPDATE SET
       work_id = excluded.work_id,
       payload_json = json_set(
         json_remove(COALESCE(publish_records.payload_json, '{}'), '$.progressRevision'),
         '$.progressGeneration',
         COALESCE(json_extract(publish_records.payload_json, '$.progressGeneration'), 0) + 1
       )
     WHERE publish_records.work_id IS NOT excluded.work_id`,
  ).run(
    sharedPublishRecordKey(params.resourceKey, "review", "progress_comment"),
    params.resourceKey,
    params.workItemId,
    params.now,
  );
}

type IntakeSink = {
  readonly events: DeferredIntakeEvent[];
  readonly conversationsToAbort: string[];
};

function deferredCorrelation(correlation: JobCorrelation) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    ...(correlation.webhookEventId ? { webhookEventId: correlation.webhookEventId } : {}),
    ...(correlation.delivery ? { delivery: correlation.delivery } : {}),
  });
}

function workLifecycleEvents(
  ref: PrRef,
  changes: readonly {
    readonly workId: string;
    readonly headSha: string;
    readonly source: string;
    readonly workType: string;
    readonly lifecycleStatus: string;
  }[],
  reason: string,
  correlation: JobCorrelation,
) {
  return changes.map((change) => ({
    name: "work_lifecycle",
    fields: {
      work_item_id: change.workId,
      installation_id: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      pr_number: ref.prNumber,
      head_sha: change.headSha,
      work_type: change.workType,
      lifecycle_status: change.lifecycleStatus,
      reason,
      source: "intake",
      trigger_source: change.source,
      ...deferredCorrelation(correlation),
    },
  }));
}

type RunInsert = {
  readonly workId: string;
  readonly kind: "review" | "description" | "verification" | "triage";
  readonly laneEpoch?: number;
  readonly payloadJson: string;
};

function insertLaneRun(db: DatabaseSync, run: RunInsert, now: number) {
  insertWorkRun(db, {
    workId: run.workId,
    prKey: prKeyFromPayload(run.payloadJson),
    kind: run.kind,
    ...(run.laneEpoch !== undefined ? { laneEpoch: run.laneEpoch } : {}),
    payloadJson: run.payloadJson,
    now,
  });
}

function prKeyFromPayload(payloadJson: string) {
  const record = parsePayloadObject(payloadJson);
  if (record !== undefined) {
    if (
      typeof record.owner === "string" &&
      typeof record.repo === "string" &&
      typeof record.prNumber === "number"
    )
      return ((pinnedReturn: string) => pinnedReturn)(
        prResourceKey(record.owner, record.repo, record.prNumber),
      );
  }
  throw new Error("work run payload missing pr ref");
}

function laneEpochFor(db: DatabaseSync, prKey: string, kind: string) {
  const column =
    kind === "review"
      ? "auto_review_epoch"
      : kind === "description"
        ? "description_epoch"
        : kind === "verification"
          ? "verification_epoch"
          : "triage_epoch";
  const row = readRow(
    db.prepare(`SELECT ${column} AS epoch FROM pr_state WHERE pr_key = ?`).get(prKey),
    v.object({ epoch: v.optional(v.number()) }),
  );
  return ((pinnedReturn: number) => pinnedReturn)(row?.epoch ?? 0);
}

function bumpLane(
  db: DatabaseSync,
  prKey: string,
  kind: "review" | "description" | "verification" | "triage",
  now: number,
) {
  ensurePrState(db, prKey, now);
  const lane = kind;
  bumpLaneEpoch(db, { prKey, lane, now });
}

type ReplaceResult = {
  readonly workItemId: string;
  readonly supersededIds: readonly string[];
  readonly conversationIds: readonly string[];
};

function replaceAutoWorkRun(
  db: DatabaseSync,
  params: {
    readonly prKey: string;
    readonly kind: "review" | "description" | "verification" | "triage";
    readonly create: (laneEpoch: number) => RunInsert;
    readonly preserveQueuedIds?: readonly string[];
  },
  now: number,
) {
  const superseded = supersedeAutoRuns(
    db,
    params.prKey,
    params.kind,
    params.preserveQueuedIds !== undefined ? { preserveQueuedIds: params.preserveQueuedIds } : {},
    now,
  );
  bumpLane(db, params.prKey, params.kind, now);
  const laneEpoch = laneEpochFor(db, params.prKey, params.kind);
  const insert = params.create(laneEpoch);
  insertLaneRun(db, insert, now);
  if (superseded.supersededIds.length > 0) {
    linkSupersededRuns(db, insert.workId, superseded.supersededIds);
  }
  return ((pinnedReturn: ReplaceResult) => pinnedReturn)({
    workItemId: insert.workId,
    supersededIds: superseded.supersededIds,
    conversationIds: superseded.conversationIds,
  });
}

function insertAckWithProgress(
  db: DatabaseSync,
  ref: PrRef,
  correlation: JobCorrelation,
  workItemId: string,
  headSha: string,
  source: WorkSource,
  now: number,
) {
  insertAckRun(
    db,
    {
      kind: "ack",
      workItemId,
      installationId: ref.installationId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      targets: [{ kind: "pr", prNumber: ref.prNumber }],
      progress: { lens: "review", headSha, source },
      ...deferredCorrelation(correlation),
      webhookReceivedAt: now,
    },
    { now },
  );
}

function dispatchAutomatedKind(
  db: DatabaseSync,
  sink: IntakeSink,
  ref: PrRef,
  resourceKey: string,
  correlation: JobCorrelation,
  descriptor: {
    readonly kind: "review" | "description" | "verification";
    readonly extraPayload: Record<string, unknown>;
    readonly withAck?: { readonly headSha: string };
  },
  eventId: string,
  headers: WebhookHeaders,
  now: number,
) {
  const replaced = replaceAutoWorkRun(
    db,
    {
      prKey: resourceKey,
      kind: descriptor.kind,
      create: (laneEpoch) => ({
        workId: randomUUID(),
        kind: descriptor.kind,
        laneEpoch,
        payloadJson: runPayload(
          { ...ref, headSha: descriptor.kind === "review" ? DEFERRED_HEAD_SHA : ref.headSha },
          "auto",
          eventId,
          headers,
          now,
          descriptor.extraPayload,
        ),
      }),
    },
    now,
  );
  sink.conversationsToAbort.push(...replaced.conversationIds);
  if (descriptor.withAck) {
    insertAckWithProgress(
      db,
      ref,
      correlation,
      replaced.workItemId,
      descriptor.withAck.headSha,
      "auto",
      now,
    );
  }
  if (descriptor.kind === "review") {
    setActiveReview(db, resourceKey, replaced.workItemId, "auto", now);
    transferProgressCommentOwnership(db, {
      workItemId: replaced.workItemId,
      resourceKey,
      now,
    });
  }
  sink.events.push(
    ...workLifecycleEvents(
      ref,
      replaced.supersededIds.map((id) => ({
        workId: id,
        headSha: ref.headSha,
        source: "auto",
        workType: descriptor.kind,
        lifecycleStatus: "superseded",
      })),
      "auto_replacement",
      correlation,
    ),
    {
      name: "agent_work_enqueued",
      fields: {
        type: descriptor.kind,
        source: "auto",
        workItemId: replaced.workItemId,
        resourceKey,
        ...deferredCorrelation(correlation),
      },
    },
  );
  return ((pinnedReturn: ReplaceResult) => pinnedReturn)(replaced);
}

type AutomatedPrIntakeKind =
  | "reviewSupersede"
  | "reviewTrackAwaitingHead"
  | "description"
  | "verification";

type ReviewAdmission =
  | { readonly kind: "review" }
  | { readonly kind: "await"; readonly workflowStartAdmits: boolean };

type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
  readonly review?: ReviewAdmission;
};

function approvalSignalDecision(admitted: number, workflowRefused: number) {
  if (admitted > 0) return ((pinnedReturn: string) => pinnedReturn)(REVIEW_APPROVED);
  if (workflowRefused > 0)
    return ((pinnedReturn: string) => pinnedReturn)(IGNORED_REVIEW_APPROVAL_MAINTAINER_REQUIRED);
  return ((pinnedReturn: string) => pinnedReturn)(IGNORED_REVIEW_APPROVAL_NOT_AWAITING);
}

function automatedIntakeDecision(plan: AutomatedPrIntakePlan) {
  const admission = plan.review;
  if (admission != null) {
    switch (admission.kind) {
      case "review":
        return ((pinnedReturn: string) => pinnedReturn)("automated_review_enqueued");
      case "await":
        return ((pinnedReturn: string) => pinnedReturn)("review_awaiting_approval");
      default:
        admission satisfies never;
        throw new Error("Unknown review admission");
    }
  }
  if (plan.kinds.includes("reviewSupersede")) {
    return ((pinnedReturn: string) => pinnedReturn)("automated_review_supersede_requested");
  }
  return ((pinnedReturn: string) => pinnedReturn)("automated_work_enqueued");
}

function admissionForApprovalOpen(authorTrust: ReviewAuthorTrust) {
  switch (authorTrust) {
    case "trusted":
      return ((pinnedReturn: ReviewAdmission) => pinnedReturn)({ kind: "review" });
    case "awaiting_maintainer_approval":
      return ((pinnedReturn: ReviewAdmission) => pinnedReturn)({
        kind: "await",
        workflowStartAdmits: false,
      });
    case "awaiting_approval":
      return ((pinnedReturn: ReviewAdmission) => pinnedReturn)({
        kind: "await",
        workflowStartAdmits: true,
      });
    default:
      authorTrust satisfies never;
      throw new Error("Unknown review author trust");
  }
}

function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<IntakeFeatures, "review" | "reviewCadence" | "describe" | "verification">,
  authorTrust: ReviewAuthorTrust = "awaiting_approval",
) {
  const kinds: AutomatedPrIntakeKind[] = [];
  let review: ReviewAdmission | undefined;
  switch (action) {
    case "opened":
      if (features.review === "auto") review = { kind: "review" };
      else if (features.review === "approval") review = admissionForApprovalOpen(authorTrust);
      if (features.describe === "auto") kinds.push("description");
      break;
    case "synchronize":
      if (features.review !== "manual") {
        kinds.push("reviewSupersede");
        if (features.review === "approval") kinds.push("reviewTrackAwaitingHead");
      }
      if (features.verification === "auto") kinds.push("verification");
      break;
  }
  return ((pinnedReturn: AutomatedPrIntakePlan) => pinnedReturn)(
    review == null ? { kinds } : { kinds, review },
  );
}

function applyOpenedReviewAdmission(
  db: DatabaseSync,
  sink: IntakeSink,
  ref: PrRef,
  resourceKey: string,
  correlation: JobCorrelation,
  eventId: string,
  headers: WebhookHeaders,
  admission: ReviewAdmission,
  now: number,
) {
  switch (admission.kind) {
    case "await": {
      if (!insertAwaitingApproval(db, ref, eventId, admission.workflowStartAdmits, now)) return;
      insertAckRun(
        db,
        {
          kind: "ack",
          installationId: ref.installationId,
          owner: ref.owner,
          repo: ref.repo,
          prNumber: ref.prNumber,
          targets: [],
          awaitingApproval: true,
          ...(admission.workflowStartAdmits ? {} : { awaitingApprovalMaintainerOnly: true }),
          ...deferredCorrelation(correlation),
          webhookReceivedAt: now,
        },
        { now },
      );
      sink.events.push({
        name: "review_awaiting_approval",
        fields: {
          resourceKey,
          workflowStartAdmits: admission.workflowStartAdmits,
          ...deferredCorrelation(correlation),
        },
      });
      return;
    }
    case "review": {
      dispatchAutomatedKind(
        db,
        sink,
        ref,
        resourceKey,
        correlation,
        {
          kind: "review",
          extraPayload: { mode: "review", ackTargets: [{ kind: "pr", prNumber: ref.prNumber }] },
          withAck: { headSha: ref.headSha },
        },
        eventId,
        headers,
        now,
      );
      return;
    }
    default:
      admission satisfies never;
      throw new Error("Unknown review admission");
  }
}

function everyPushReviewAdmitted(
  db: DatabaseSync,
  resourceKey: string,
  reviewMode: IntakeFeatures["review"],
) {
  if (reviewMode !== "approval") return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (loadAwaitingApproval(db, resourceKey) !== undefined)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(reviewPushAdmitted(db, resourceKey));
}

function insertEveryPushReview(
  db: DatabaseSync,
  sink: IntakeSink,
  ref: PrRef,
  resourceKey: string,
  correlation: JobCorrelation,
  eventId: string,
  headers: WebhookHeaders,
  now: number,
) {
  const replaced = dispatchAutomatedKind(
    db,
    sink,
    ref,
    resourceKey,
    correlation,
    {
      kind: "review",
      extraPayload: { mode: "review", ackTargets: [{ kind: "pr", prNumber: ref.prNumber }] },
      withAck: { headSha: DEFERRED_HEAD_SHA },
    },
    eventId,
    headers,
    now,
  );
  if (replaced.supersededIds.length > 0) {
    const last = sink.events[sink.events.length - 1];
    sink.events.splice(
      sink.events.length - 1,
      1,
      {
        name: "agent_work_cancel_requested",
        fields: {
          type: "review",
          source: "auto",
          workItemId: replaced.supersededIds[0],
          resourceKey,
          cancelledCount: replaced.supersededIds.length,
          cancelledIds: replaced.supersededIds,
          ...deferredCorrelation(correlation),
        },
      },
      last !== undefined
        ? last
        : {
            name: "agent_work_enqueued",
            fields: {
              type: "review",
              source: "auto",
              workItemId: replaced.workItemId,
              resourceKey,
              ...deferredCorrelation(correlation),
            },
          },
    );
  }
}

function applyEveryPushReviewSupersede(
  db: DatabaseSync,
  sink: IntakeSink,
  ref: PrRef,
  resourceKey: string,
  correlation: JobCorrelation,
  eventId: string,
  headers: WebhookHeaders,
  now: number,
) {
  const slashRows = activeSlashRuns(db, resourceKey, "review");
  if (slashRows.length === 0) {
    insertEveryPushReview(db, sink, ref, resourceKey, correlation, eventId, headers, now);
    return;
  }
  const followUpIds = [
    ...new Set(
      slashRows.flatMap((row) =>
        row.followUpReplacementId == null ? [] : [row.followUpReplacementId],
      ),
    ),
  ];
  const preservedFollowUpIds = followUpIds.filter((id) => {
    const row = readRow(
      db.prepare(`SELECT status FROM work_runs WHERE work_id = ?`).get(id),
      v.object({ status: v.optional(v.string()) }),
    );
    return (
      row?.status === "pending_dispatch" ||
      row?.status === "retry_scheduled" ||
      row?.status === "running"
    );
  });
  const superseded = supersedeAutoRuns(
    db,
    resourceKey,
    "review",
    {
      preserveQueuedIds: preservedFollowUpIds,
    },
    now,
  );
  sink.conversationsToAbort.push(...superseded.conversationIds);
  sink.events.push(
    ...workLifecycleEvents(
      ref,
      superseded.supersededIds.map((id) => ({
        workId: id,
        headSha: ref.headSha,
        source: "auto",
        workType: "review",
        lifecycleStatus: "superseded",
      })),
      "auto_replacement",
      correlation,
    ),
  );
  if (superseded.supersededIds.length > 0) {
    sink.events.push({
      name: "agent_work_cancel_requested",
      fields: {
        type: "review",
        source: "auto",
        workItemId: superseded.supersededIds[0],
        resourceKey,
        cancelledCount: superseded.supersededIds.length,
        cancelledIds: superseded.supersededIds,
        ...deferredCorrelation(correlation),
      },
    });
  }
  const runningIds = slashRows
    .filter((row) => row.status === "running" && !row.hasFollowUp)
    .map((row) => row.workId);
  if (runningIds.length === 0) {
    if (followUpIds.length === 0) return;
    if (preservedFollowUpIds.length > 0) {
      const queuedFollowUp = readRows(
        db
          .prepare(
            `SELECT work_id FROM work_runs WHERE work_id IN (${preservedFollowUpIds.map(() => "?").join(",")})
             AND status = 'pending_dispatch'`,
          )
          .all(...preservedFollowUpIds),
        workIdRowSchema,
      );
      if (queuedFollowUp.length > 0) return;
    }
    insertEveryPushReview(db, sink, ref, resourceKey, correlation, eventId, headers, now);
    return;
  }
  const stamped = db
    .prepare(
      `UPDATE work_runs
         SET payload_json = json_set(payload_json, '$.pushFollowUp', json_object('webhookEventId', ?)),
             updated_at = ?
       WHERE work_id IN (${runningIds.map(() => "?").join(",")})
         AND status = 'running'
         AND json_extract(payload_json, '$.pushFollowUp') IS NULL`,
    )
    .run(eventId, now, ...runningIds);
  if (stamped.changes > 0) return;
  if (activeSlashRuns(db, resourceKey, "review").length > 0) return;
  const finished = readRows(
    db
      .prepare(
        `SELECT status, work_id, payload_json FROM work_runs WHERE work_id IN (${runningIds.map(() => "?").join(",")})`,
      )
      .all(...runningIds),
    activeRunRowSchema,
  );
  if (!finished.some((row) => row.status === "completed")) return;
  insertEveryPushReview(db, sink, ref, resourceKey, correlation, eventId, headers, now);
}

function applyPlannedAutomatedPullRequestIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  ref: PrRef,
  plan: AutomatedPrIntakePlan,
  reviewCadence: IntakeFeatures["reviewCadence"],
  reviewMode: IntakeFeatures["review"],
  pushBeforeSha: string | undefined,
  now: number,
) {
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  let reviewRefused: "closed" | "merged" | undefined;
  if (plan.review != null || plan.kinds.some((kind) => kind.startsWith("review"))) {
    const lifecycle = loadPrState(db, resourceKey);
    if (lifecycle !== undefined && lifecycle.lifecycle_state !== "open") {
      reviewRefused = lifecycle.lifecycle_state === "merged" ? "merged" : "closed";
      plan = { kinds: plan.kinds.filter((kind) => !kind.startsWith("review")) };
    }
  }
  const decision =
    reviewRefused != null && plan.kinds.length === 0 && plan.review == null
      ? `ignored_review_pr_${reviewRefused}`
      : automatedIntakeDecision(plan);
  const event = insertWebhookEvent(db, headers, decision, now);
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return ((pinnedReturn: { readonly duplicate: true }) => pinnedReturn)({ duplicate: true });
  }
  const correlation = jobCorrelation(event.id, headers);
  if (reviewRefused != null) {
    sink.events.push({
      name: "review_intake_refused",
      fields: {
        resourceKey,
        reason: reviewRefused,
        source: "auto",
        ...deferredCorrelation(correlation),
      },
    });
  }
  if (plan.review != null) {
    applyOpenedReviewAdmission(
      db,
      sink,
      ref,
      resourceKey,
      correlation,
      event.id,
      headers,
      plan.review,
      now,
    );
  }
  if (plan.kinds.includes("reviewTrackAwaitingHead")) {
    ensurePrState(db, resourceKey, now);
    moveAwaitingHead(db, resourceKey, ref.headSha, now);
  }
  if (plan.kinds.includes("reviewSupersede")) {
    if (reviewCadence === "every_push" && everyPushReviewAdmitted(db, resourceKey, reviewMode)) {
      applyEveryPushReviewSupersede(
        db,
        sink,
        ref,
        resourceKey,
        correlation,
        event.id,
        headers,
        now,
      );
    } else {
      const superseded = supersedeAutoRuns(db, resourceKey, "review", {}, now);
      sink.conversationsToAbort.push(...superseded.conversationIds);
      if (superseded.supersededIds.length > 0) {
        bumpLane(db, resourceKey, "review", now);
        const laneEpoch = laneEpochFor(db, resourceKey, "review");
        const workId = randomUUID();
        insertWorkRun(db, {
          workId,
          prKey: resourceKey,
          kind: "review",
          laneEpoch,
          payloadJson: runPayload(
            { ...ref, headSha: DEFERRED_HEAD_SHA },
            "auto",
            event.id,
            headers,
            now,
            {
              mode: "review",
              ackTargets: [{ kind: "pr", prNumber: ref.prNumber }],
            },
          ),
          now,
        });
        linkSupersededRuns(db, workId, superseded.supersededIds);
        setActiveReview(db, resourceKey, workId, "auto", now);
        transferProgressCommentOwnership(db, { workItemId: workId, resourceKey, now });
        insertAckWithProgress(db, ref, correlation, workId, DEFERRED_HEAD_SHA, "auto", now);
        clearActiveReview(db, resourceKey, superseded.supersededIds, now);
        sink.events.push(
          ...workLifecycleEvents(
            ref,
            superseded.supersededIds.map((id) => ({
              workId: id,
              headSha: ref.headSha,
              source: "auto",
              workType: "review",
              lifecycleStatus: "superseded",
            })),
            "auto_replacement",
            correlation,
          ),
          {
            name: "agent_work_cancel_requested",
            fields: {
              type: "review",
              source: "auto",
              workItemId: superseded.supersededIds[0],
              resourceKey,
              cancelledCount: superseded.supersededIds.length,
              cancelledIds: superseded.supersededIds,
              ...deferredCorrelation(correlation),
            },
          },
          {
            name: "agent_work_enqueued",
            fields: {
              type: "review",
              source: "auto",
              workItemId: workId,
              resourceKey,
              ...deferredCorrelation(correlation),
            },
          },
        );
      }
    }
  }
  if (plan.kinds.includes("description")) {
    dispatchAutomatedKind(
      db,
      sink,
      ref,
      resourceKey,
      correlation,
      {
        kind: "description",
        extraPayload: { ackTargets: [{ kind: "pr", prNumber: ref.prNumber }] },
      },
      event.id,
      headers,
      now,
    );
  }
  if (plan.kinds.includes("verification")) {
    dispatchAutomatedKind(
      db,
      sink,
      ref,
      resourceKey,
      correlation,
      {
        kind: "verification",
        extraPayload: {
          ...(pushBeforeSha != null ? { pushBeforeSha } : {}),
          ackTargets: [{ kind: "pr", prNumber: ref.prNumber }],
        },
      },
      event.id,
      headers,
      now,
    );
  }
  return ((pinnedReturn: { readonly duplicate: false; readonly correlation: JobCorrelation }) =>
    pinnedReturn)({ duplicate: false, correlation });
}

function applyReviewCloseCancelIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  ref: PrRef,
  observation: ReviewLifecycleObservation,
  now: number,
) {
  const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
  const observed = { state: observation.state, observedAt: observedAtMs(observation.observedAt) };
  const existing = loadPrState(db, resourceKey);
  const accepts = lifecycleObservationAccepted(
    existing === undefined
      ? undefined
      : { state: existing.lifecycle_state, observedAt: existing.observed_at },
    observed,
  );
  const event = insertWebhookEvent(
    db,
    headers,
    accepts ? REVIEW_CANCELLED_PR_CLOSED : "ignored_stale_pr_lifecycle",
    now,
  );
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  const correlation = jobCorrelation(event.id, headers);
  if (!accepts) {
    sink.events.push({
      name: "ignored_stale_pr_lifecycle",
      fields: { resourceKey, state: observation.state, ...deferredCorrelation(correlation) },
    });
    return;
  }
  if (!recordLifecycleObservation(db, resourceKey, observed, now)) {
    throw new Error("Locked lifecycle observation changed during delivery");
  }
  const attribution = reviewCancelAttributionForClosedPr(observation.state === "merged");
  if (withdrawAwaiting(db, resourceKey, now)) {
    insertAckRun(
      db,
      {
        kind: "ack",
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        targets: [],
        closedApproval: attribution,
        ...deferredCorrelation(correlation),
        webhookReceivedAt: now,
      },
      { now },
    );
  }
  const cancelledReviews = cancelActiveRunsOfKind(
    db,
    resourceKey,
    "review",
    attribution,
    ref.prNumber,
    now,
  );
  const cancelledTriage = cancelActiveRunsOfKind(
    db,
    resourceKey,
    "triage",
    attribution,
    ref.prNumber,
    now,
  );
  for (const run of [...cancelledReviews, ...cancelledTriage]) {
    if (run.conversationId !== undefined) sink.conversationsToAbort.push(run.conversationId);
  }
  sink.events.push(
    ...workLifecycleEvents(
      ref,
      [
        ...cancelledReviews.map((row) => ({
          workId: row.workId,
          headSha: row.headSha,
          source: row.source,
          workType: "review",
          lifecycleStatus: "cancelled",
        })),
        ...cancelledTriage.map((row) => ({
          workId: row.workId,
          headSha: row.headSha,
          source: row.source,
          workType: "triage",
          lifecycleStatus: "cancelled",
        })),
      ],
      observation.state === "merged" ? "pr_merged" : "pr_closed",
      correlation,
    ),
  );
  const primaryReview = cancelledReviews[0];
  const primaryTriage = cancelledTriage[0];
  if (primaryReview != null || primaryTriage != null) {
    const cancelledReviewIds = cancelledReviews.map((row) => row.workId);
    const cancelledTriageIds = cancelledTriage.map((row) => row.workId);
    insertAckRun(
      db,
      {
        kind: "ack",
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        targets: [],
        ...(primaryReview != null
          ? {
              cancelProgress: {
                workItemId: primaryReview.workId,
                cancelledWorkItemIds: cancelledReviewIds,
                attribution,
              },
            }
          : {}),
        ...(primaryTriage != null && primaryTriage.replyTarget !== undefined
          ? {
              cancelTriage: {
                workItemId: primaryTriage.workId,
                cancelledWorkItemIds: cancelledTriageIds,
                attribution,
                targets: primaryTriage.ackTargets ?? [],
                replyTarget: primaryTriage.replyTarget,
              },
            }
          : {}),
        ...deferredCorrelation(correlation),
        webhookReceivedAt: now,
      },
      { now },
    );
  }
  const cancelledReviewIds = cancelledReviews.map((row) => row.workId);
  const cancelledTriageIds = cancelledTriage.map((row) => row.workId);
  sink.events.push({
    name: REVIEW_CANCELLED_PR_CLOSED,
    fields: {
      resourceKey,
      cancelledCount: cancelledReviewIds.length + cancelledTriageIds.length,
      cancelledIds: [...cancelledReviewIds, ...cancelledTriageIds],
      cancelledReviewCount: cancelledReviewIds.length,
      cancelledTriageCount: cancelledTriageIds.length,
      cancelledTriageIds,
      prMerged: attribution.kind === "merged",
      ...deferredCorrelation(correlation),
    },
  });
}

function applyAutomatedPullRequestIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  command: Extract<IntakeCommand, { kind: "pull_request" }>,
  features: IntakeFeatures,
  now: number,
) {
  const { headers, ref, action, opts } = command;
  if (action === "closed") {
    if (!opts?.lifecycle)
      throw new Error("Close and reopen require a validated lifecycle observation");
    applyReviewCloseCancelIntake(db, sink, headers, ref, opts.lifecycle, now);
    return;
  }
  let reopenAccepted: boolean | undefined;
  if (action === "reopened") {
    if (!opts?.lifecycle)
      throw new Error("Close and reopen require a validated lifecycle observation");
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const existing = loadPrState(db, resourceKey);
    reopenAccepted = lifecycleObservationAccepted(
      existing === undefined
        ? undefined
        : { state: existing.lifecycle_state, observedAt: existing.observed_at },
      { state: opts.lifecycle.state, observedAt: observedAtMs(opts.lifecycle.observedAt) },
    );
  }
  const plan = planAutomatedPullRequestIntake(action, features, opts?.authorTrust);
  if (plan.kinds.length > 0 || plan.review != null) {
    const planned = applyPlannedAutomatedPullRequestIntake(
      db,
      sink,
      headers,
      ref,
      plan,
      features.reviewCadence,
      features.review,
      opts?.pushBeforeSha,
      now,
    );
    if (planned.duplicate) return;
    const row = loadPrHeadCiState(db, {
      repoKey: `${ref.owner}/${ref.repo}`,
      headSha: ref.headSha,
    });
    if (shouldSeedHeadCiFromPullRequest(action, ref.headSha, row ?? null)) {
      insertCiProjectionRun(
        db,
        {
          installationId: ref.installationId,
          owner: ref.owner,
          repo: ref.repo,
          headSha: ref.headSha,
          correlation: planned.correlation,
        },
        now,
      );
      sink.events.push({
        name: "ci_projection_enqueued",
        fields: { owner: ref.owner, repo: ref.repo, headSha: ref.headSha, result: "enqueued" },
      });
    }
    return;
  }
  const seedCandidate = isHeadCiSeedPullRequest(action, ref.headSha);
  const row = seedCandidate
    ? loadPrHeadCiState(db, { repoKey: `${ref.owner}/${ref.repo}`, headSha: ref.headSha })
    : undefined;
  const seed = seedCandidate && headCiNeedsSeedForRow(row ?? null);
  const lifecycleDecision = reopenAccepted
    ? "pr_review_lifecycle_applied"
    : "ignored_stale_pr_lifecycle";
  const event = insertWebhookEvent(
    db,
    headers,
    seed
      ? "ci_projection_enqueued"
      : reopenAccepted != null
        ? lifecycleDecision
        : `ignored_pull_request_${action}`,
    now,
  );
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  const correlation = jobCorrelation(event.id, headers);
  if (reopenAccepted != null && opts?.lifecycle != null) {
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    if (
      reopenAccepted &&
      !recordLifecycleObservation(
        db,
        resourceKey,
        { state: opts.lifecycle.state, observedAt: observedAtMs(opts.lifecycle.observedAt) },
        now,
      )
    )
      throw new Error("Locked lifecycle observation changed during delivery");
    sink.events.push({
      name: lifecycleDecision,
      fields: { resourceKey, state: opts.lifecycle.state, ...deferredCorrelation(correlation) },
    });
  }
  if (seed) {
    insertCiProjectionRun(
      db,
      {
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        headSha: ref.headSha,
        correlation,
      },
      now,
    );
    sink.events.push({
      name: "ci_projection_enqueued",
      fields: { owner: ref.owner, repo: ref.repo, headSha: ref.headSha, result: "enqueued" },
    });
  }
}

function applyReviewApprovedIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  signal: ReviewApprovalSignal,
  now: number,
) {
  const targets: PrRef[] =
    signal.kind === "pull_request_review"
      ? [signal.ref]
      : [
          ...findAwaitingForHead(db, signal.owner, signal.repo, signal.headSha).map((row) => ({
            owner: signal.owner,
            repo: signal.repo,
            prNumber: row.prNumber,
            headSha: signal.headSha,
            installationId: signal.installationId,
          })),
          ...signal.prNumbers.map((prNumber) => ({
            owner: signal.owner,
            repo: signal.repo,
            prNumber,
            headSha: signal.headSha,
            installationId: signal.installationId,
          })),
        ];
  const refs = new Map(
    targets.map((ref) => [prResourceKey(ref.owner, ref.repo, ref.prNumber), ref]),
  );
  const admitted: PrRef[] = [];
  const workflowRefused: string[] = [];
  for (const [resourceKey, ref] of [...refs.entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const lifecycle = loadPrState(db, resourceKey);
    if (lifecycle !== undefined && lifecycle.lifecycle_state !== "open") continue;
    const awaiting = loadAwaitingApproval(
      db,
      resourceKey,
      signal.kind === "workflow_run" ? signal.headSha : undefined,
    );
    if (awaiting === undefined) continue;
    if (signal.kind === "workflow_run" && !awaiting.workflowStartAdmits) {
      workflowRefused.push(resourceKey);
      continue;
    }
    admitted.push(ref);
  }
  const decision = approvalSignalDecision(admitted.length, workflowRefused.length);
  const event = insertWebhookEvent(db, headers, decision, now);
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  const correlation = jobCorrelation(event.id, headers);
  for (const resourceKey of workflowRefused) {
    sink.events.push({
      name: "review_approval_signal_refused",
      fields: {
        resourceKey,
        signal: "workflow_run",
        reason: "maintainer_required",
        ...deferredCorrelation(correlation),
      },
    });
  }
  for (const ref of admitted) {
    const resourceKey = prResourceKey(ref.owner, ref.repo, ref.prNumber);
    const approved = approveAwaiting(
      db,
      resourceKey,
      signal.kind,
      signal.kind === "workflow_run" ? signal.headSha : undefined,
      now,
    );
    if (approved === undefined) {
      throw new Error("Locked awaiting approval changed during delivery");
    }
    const deferredRef = { ...ref, headSha: DEFERRED_HEAD_SHA };
    dispatchAutomatedKind(
      db,
      sink,
      deferredRef,
      resourceKey,
      correlation,
      {
        kind: "review",
        extraPayload: { mode: "review", ackTargets: [{ kind: "pr", prNumber: ref.prNumber }] },
        withAck: { headSha: DEFERRED_HEAD_SHA },
      },
      event.id,
      headers,
      now,
    );
  }
  sink.events.push({
    name: decision,
    fields: { signal: signal.kind, ...deferredCorrelation(correlation) },
  });
}

function applyCompletedRunCiIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  data: Extract<IntakeCommand, { kind: "ci_refresh" }>["data"],
  now: number,
) {
  const event = insertWebhookEvent(db, headers, "ci_projection_enqueued", now);
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  insertCiProjectionRun(
    db,
    {
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      correlation: jobCorrelation(event.id, headers),
      prNumbers: data.prNumbers,
    },
    now,
  );
  sink.events.push({
    name: "ci_projection_enqueued",
    fields: {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      prCount: data.prNumbers.length,
      result: "enqueued",
    },
  });
}

function applyCiStateIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  data: CiStateFactInput,
  now: number,
) {
  const event = insertWebhookEvent(db, headers, "ci_state_applied", now);
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  const repoKey = `${data.owner}/${data.repo}`;
  const applied = applyPrHeadCiFactTx(
    db,
    {
      installationId: data.installationId,
      repoKey,
      headSha: data.headSha,
      fact: data.fact,
    },
    now,
  );
  sink.events.push({
    name: "ci_state_applied",
    fields: {
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      name: data.fact.name,
      accepted: applied.accepted,
      version: applied.version,
    },
  });
  if (!applied.accepted) return;
  if (applied.previousRollup !== applied.rollup) {
    sink.events.push({
      name: "ci_state_changed",
      fields: {
        installationId: data.installationId,
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
        fromRollup: applied.previousRollup,
        toRollup: applied.rollup,
        version: applied.version,
      },
    });
  }
  insertCiProjectionRun(
    db,
    {
      installationId: data.installationId,
      owner: data.owner,
      repo: data.repo,
      headSha: data.headSha,
      correlation: jobCorrelation(event.id, headers),
    },
    now,
  );
  sink.events.push({
    name: "ci_projection_enqueued",
    fields: { owner: data.owner, repo: data.repo, headSha: data.headSha, result: "enqueued" },
  });
}

function applyVerificationReplyIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  headers: WebhookHeaders,
  command: Extract<IntakeCommand, { kind: "verification_reply" }>,
  now: number,
) {
  const event = insertWebhookEvent(db, headers, "verification_reply", now);
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: headers.event },
    });
    return;
  }
  const resourceKey = prResourceKey(command.owner, command.repo, command.prNumber);
  const active = readRow(
    db
      .prepare(
        `SELECT work_id FROM work_runs
        WHERE pr_key = ? AND kind = 'verification' AND status IN ${ACTIVE_RUN_STATUSES}
        LIMIT 1`,
      )
      .get(resourceKey),
    workIdRowSchema,
  );
  if (active !== undefined) return;
  const workId = randomUUID();
  insertWorkRun(db, {
    workId,
    prKey: resourceKey,
    kind: "verification",
    payloadJson: runPayload(
      {
        owner: command.owner,
        repo: command.repo,
        prNumber: command.prNumber,
        installationId: command.installationId,
        headSha: DEFERRED_HEAD_SHA,
        ...(command.repositorySizeKb != null ? { repositorySizeKb: command.repositorySizeKb } : {}),
      },
      "auto",
      event.id,
      headers,
      now,
      {},
    ),
    now,
  });
  const correlation = jobCorrelation(event.id, headers);
  sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "verification",
      source: "auto",
      workItemId: workId,
      resourceKey,
      ...deferredCorrelation(correlation),
    },
  });
}

function clampStoredCommentText(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text.split("\u0000").join("").slice(0, MAX_STORED_COMMENT_TEXT_LEN),
  );
}

type SlashContext = {
  readonly db: DatabaseSync;
  readonly sink: IntakeSink;
  readonly input: SlashCommandInput;
  readonly eventId: string;
  readonly correlation: JobCorrelation;
  readonly ref: PrRef;
  readonly targets: readonly AckTarget[];
  readonly askQuota: AskQuotaConfig;
  readonly features: IntakeFeatures;
  readonly reviewRefused?: "closed" | "merged";
  readonly now: number;
};

function slashAckData(ctx: SlashContext, extra: Partial<AckJobData>) {
  return ((pinnedReturn: AckJobData & { readonly webhookReceivedAt: number }) => pinnedReturn)({
    kind: "ack",
    installationId: ctx.input.installationId,
    owner: ctx.input.owner,
    repo: ctx.input.repo,
    prNumber: ctx.input.prNumber,
    targets: ctx.targets,
    commenterId: ctx.input.commenterId,
    ...deferredCorrelation(ctx.correlation),
    ...extra,
    webhookReceivedAt: ctx.now,
  });
}

function enqueueSlashAck(ctx: SlashContext, extra: Partial<AckJobData>, workId?: string) {
  insertAckRun(ctx.db, slashAckData(ctx, extra), {
    ...(workId !== undefined ? { workId } : {}),
    now: ctx.now,
  });
}

function findRetainedAskForMention(
  db: DatabaseSync,
  input: {
    readonly installationId: number;
    readonly resourceKey: string;
    readonly replyTargetKind: string;
    readonly commentId: number;
    readonly webhookEventId: string;
  },
) {
  const rows = readRows(
    db
      .prepare(
        `SELECT work_id, payload_json, 'active' AS status FROM work_runs
         WHERE kind = 'ask'
           AND json_extract(payload_json, '$.installationId') = ?
           AND pr_key = ?
           AND json_extract(payload_json, '$.replyTarget.kind') = ?
           AND json_extract(payload_json, '$.commentId') = ?
         ORDER BY CASE WHEN json_extract(payload_json, '$.webhookEventId') = ? THEN 0 ELSE 1 END,
                  created_at, work_id
         LIMIT 1`,
      )
      .all(
        input.installationId,
        input.resourceKey,
        input.replyTargetKind,
        input.commentId,
        input.webhookEventId,
      ),
    activeRunRowSchema,
  );
  const row = rows[0];
  if (row === undefined)
    return ((
      pinnedReturn: { readonly id: string; readonly webhookEventId: string | null } | undefined,
    ) => pinnedReturn)(undefined);
  const record = parsePayloadObject(row.payload_json) ?? {};
  return ((
    pinnedReturn: { readonly id: string; readonly webhookEventId: string | null } | undefined,
  ) => pinnedReturn)({
    id: row.work_id,
    webhookEventId: typeof record.webhookEventId === "string" ? record.webhookEventId : null,
  });
}

type AskAdmission =
  | { readonly kind: "admitted"; readonly id: string; readonly created: boolean }
  | { readonly kind: "retained"; readonly id: string; readonly webhookEventId: string | null }
  | { readonly kind: "throttled"; readonly reason: AskQuotaRejectionReason };

function admitAsk(
  db: DatabaseSync,
  input: {
    readonly webhookEventId: string;
    readonly ref: PrRef;
    readonly question: string;
    readonly replyTarget: SlashCommandInput["replyTarget"];
    readonly commentId: number;
    readonly commenterId: number;
    readonly codeAnchor?: SlashCommandInput["codeAnchor"];
    readonly ackTargets: readonly AckTarget[];
    readonly headers: WebhookHeaders;
  },
  config: AskQuotaConfig,
  now: number,
) {
  const resourceKey = prResourceKey(input.ref.owner, input.ref.repo, input.ref.prNumber);
  const retained = findRetainedAskForMention(db, {
    installationId: input.ref.installationId,
    resourceKey,
    replyTargetKind: input.replyTarget.kind,
    commentId: input.commentId,
    webhookEventId: input.webhookEventId,
  });
  if (retained !== undefined)
    return ((pinnedReturn: AskAdmission) => pinnedReturn)({ kind: "retained", ...retained });
  const workItemId = randomUUID();
  const reservation = reserveAskQuotaTx(
    db,
    {
      workItemId,
      installationId: input.ref.installationId,
      owner: input.ref.owner,
      repo: input.ref.repo,
      commenterId: input.commenterId,
      triggerCommentId: input.commentId,
      triggerScopeKey: `${input.ref.owner}/${input.ref.repo}/${input.ref.prNumber}/${input.replyTarget.kind}`,
    },
    config,
    now,
  );
  if (reservation.kind === "throttled")
    return ((pinnedReturn: AskAdmission) => pinnedReturn)(reservation);
  const existing = readRow(
    db
      .prepare(
        `SELECT work_id FROM work_runs
         WHERE kind = 'ask' AND json_extract(payload_json, '$.webhookEventId') = ?
         LIMIT 1`,
      )
      .get(input.webhookEventId),
    workIdRowSchema,
  );
  if (existing !== undefined) {
    releaseAskQuotaReservationTx(db, workItemId, now);
    return ((pinnedReturn: AskAdmission) => pinnedReturn)({
      kind: "admitted",
      id: existing.work_id ?? workItemId,
      created: false,
    });
  }
  insertWorkRun(db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "ask",
    payloadJson: runPayload(input.ref, "slash", input.webhookEventId, input.headers, now, {
      question: input.question,
      replyTarget: input.replyTarget,
      commentId: input.commentId,
      commenterId: input.commenterId,
      ...(input.codeAnchor !== undefined ? { codeAnchor: input.codeAnchor } : {}),
      ackTargets: input.ackTargets,
      providerReservationTokens: reservation.providerReservationTokens,
    }),
    now,
  });
  return ((pinnedReturn: AskAdmission) => pinnedReturn)({
    kind: "admitted",
    id: workItemId,
    created: true,
  });
}

function promoteAsk(ctx: SlashContext) {
  const askParse = parseAskQuestion(ctx.input.body, ctx.input.botLogin);
  switch (askParse.kind) {
    case "too_long": {
      enqueueSlashAck(
        ctx,
        {
          reply: { target: ctx.input.replyTarget, body: ASK_QUESTION_TOO_LONG_HINT },
        },
        `ask-ack:${ctx.eventId}`,
      );
      return;
    }
    case "missing":
    case "not_ask": {
      enqueueSlashAck(
        ctx,
        { reply: { target: ctx.input.replyTarget, body: ASK_USAGE_HINT } },
        `ask-ack:${ctx.eventId}`,
      );
      return;
    }
    case "ok":
      break;
    default: {
      const exhaustive: never = askParse;
      void exhaustive;
      return;
    }
  }
  const admission = admitAsk(
    ctx.db,
    {
      webhookEventId: ctx.eventId,
      ref: ctx.ref,
      question: redactOutboundSecrets(askParse.question),
      replyTarget: ctx.input.replyTarget,
      commentId: ctx.input.commentId,
      commenterId: ctx.input.commenterId,
      ...(ctx.input.codeAnchor !== undefined ? { codeAnchor: ctx.input.codeAnchor } : {}),
      ackTargets: ctx.targets,
      headers: ctx.input.headers,
    },
    ctx.askQuota,
    ctx.now,
  );
  if (admission.kind === "retained") {
    if (admission.webhookEventId !== ctx.eventId) {
      return;
    }
    enqueueSlashAck(ctx, { workItemId: admission.id }, `ask-ack:${ctx.eventId}`);
    ctx.sink.events.push({
      name: "agent_work_enqueued",
      fields: {
        type: "ask",
        source: "slash",
        workItemId: admission.id,
        ...deferredCorrelation(ctx.correlation),
      },
    });
    return;
  }
  if (admission.kind === "throttled") {
    enqueueSlashAck(
      ctx,
      { reply: { target: ctx.input.replyTarget, body: ASK_THROTTLED_BODY } },
      `ask-ack:${ctx.eventId}`,
    );
    ctx.sink.events.push({
      name: "agent_work_throttled",
      fields: {
        type: "ask",
        source: "slash",
        reason: admission.reason,
        ...deferredCorrelation(ctx.correlation),
      },
    });
    return;
  }
  if (!admission.created) return;
  enqueueSlashAck(ctx, { workItemId: admission.id }, `ask-ack:${ctx.eventId}`);
  ctx.sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "ask",
      source: "slash",
      workItemId: admission.id,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function slashActiveConflictWorkId(ctx: SlashContext, kind: string) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const rows = activeSlashRuns(ctx.db, resourceKey, kind);
  const winner = rows[0];
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    winner !== undefined ? winner.workId : undefined,
  );
}

function handleSlashDescribe(ctx: SlashContext) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  if (slashActiveConflictWorkId(ctx, "description") !== undefined) {
    enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: DESCRIPTION_ALREADY_IN_PROGRESS },
    });
    return;
  }
  const workItemId = randomUUID();
  insertWorkRun(ctx.db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "description",
    payloadJson: runPayload(ctx.ref, "slash", ctx.eventId, ctx.input.headers, ctx.now, {
      userSupplement: clampStoredCommentText(`User invoked /describe with:\n${ctx.input.body}`),
      commenterId: ctx.input.commenterId,
      ackTargets: ctx.targets,
    }),
    now: ctx.now,
  });
  enqueueSlashAck(ctx, { workItemId });
  ctx.sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "description",
      source: "slash",
      workItemId,
      resourceKey,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function handleSlashTriage(ctx: SlashContext) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const parsed = parseTriageCommand(ctx.input.body) ?? { kind: "apply" as const };
  if (parsed.kind === "invalid") {
    enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body:
          parsed.reason === "invalid_exclude" ? TRIAGE_INVALID_EXCLUDE : TRIAGE_UNKNOWN_SUBCOMMAND,
      },
    });
    return;
  }
  const mode: TriageMode = parsed.kind;
  const excludeThreadRootCommentIds =
    parsed.kind === "bulk" ? parsed.excludeThreadRootCommentIds : undefined;
  const isInlineReply = ctx.input.replyTarget.kind === "inlineReviewThread";
  const scope =
    mode === "bulk"
      ? ("all" as const)
      : (ctx.input.triageScope ?? (isInlineReply ? undefined : ("all" as const)));
  if (isInlineReply && scope == null) {
    enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: TRIAGE_INLINE_USAGE_HINT },
    });
    return;
  }
  const triageScope = scope ?? "all";
  const conflictId = slashActiveConflictWorkId(ctx, "triage");
  if (conflictId !== undefined) {
    const winnerRow = readRow(
      ctx.db
        .prepare(`SELECT work_id, status, payload_json FROM work_runs WHERE work_id = ?`)
        .get(conflictId),
      activeRunRowSchema,
    );
    const winnerPayload =
      winnerRow !== undefined ? parsePayloadObject(winnerRow.payload_json) : undefined;
    const activeScope = winnerPayload?.scope === "thread" ? "thread" : "all";
    enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body:
          triageScope === "thread" && activeScope === "all"
            ? TRIAGE_FULL_RUN_IN_PROGRESS
            : TRIAGE_ALREADY_IN_PROGRESS,
      },
    });
    return;
  }
  const workItemId = randomUUID();
  insertWorkRun(ctx.db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "triage",
    payloadJson: runPayload(ctx.ref, "slash", ctx.eventId, ctx.input.headers, ctx.now, {
      commentId: ctx.input.commentId,
      commenterId: ctx.input.commenterId,
      scope: triageScope,
      ...(mode !== "apply" ? { mode } : {}),
      ...(excludeThreadRootCommentIds != null && excludeThreadRootCommentIds.length > 0
        ? { excludeThreadRootCommentIds }
        : {}),
      ...(ctx.input.threadAnchorCommentId != null
        ? { threadAnchorCommentId: ctx.input.threadAnchorCommentId }
        : {}),
      ...(ctx.input.needsThreadRootResolution != null
        ? { needsThreadRootResolution: ctx.input.needsThreadRootResolution }
        : {}),
      replyTarget: ctx.input.replyTarget,
      ackTargets: ctx.targets,
    }),
    now: ctx.now,
  });
  enqueueSlashAck(ctx, { workItemId });
  ctx.sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "triage",
      source: "slash",
      workItemId,
      resourceKey,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function handleSlashReview(ctx: SlashContext) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  if (ctx.reviewRefused != null) {
    enqueueSlashAck(ctx, {
      reply: {
        target: ctx.input.replyTarget,
        body:
          ctx.reviewRefused === "closed"
            ? "This pull request is closed. Reopen it before running `/review`."
            : "This pull request is merged. Run `/review` on an open pull request.",
      },
    });
    ctx.sink.events.push({
      name: "review_intake_refused",
      fields: {
        resourceKey,
        source: "slash",
        reason: ctx.reviewRefused,
        ...deferredCorrelation(ctx.correlation),
      },
    });
    return;
  }
  const force = isReviewForceCommand(ctx.input.body);
  let cancelProgress: AckJobData["cancelProgress"];
  if (force) {
    const attribution = {
      kind: "user" as const,
      login: sanitizeGithubLogin(ctx.input.commenterLogin ?? ""),
    };
    const cancelled = cancelActiveRunsOfKind(
      ctx.db,
      resourceKey,
      "review",
      attribution,
      ctx.input.prNumber,
      ctx.now,
    );
    for (const run of cancelled) {
      if (run.conversationId !== undefined) ctx.sink.conversationsToAbort.push(run.conversationId);
    }
    ctx.sink.events.push(
      ...workLifecycleEvents(
        ctx.ref,
        cancelled.map((row) => ({
          workId: row.workId,
          headSha: row.headSha,
          source: row.source,
          workType: "review",
          lifecycleStatus: "cancelled",
        })),
        "review_force",
        ctx.correlation,
      ),
    );
    const primary = cancelled[0];
    if (primary != null) {
      cancelProgress = {
        workItemId: primary.workId,
        cancelledWorkItemIds: cancelled.map((row) => row.workId),
        attribution,
      };
      ctx.sink.events.push({
        name: "agent_work_cancel_requested",
        fields: {
          type: "review",
          source: "slash",
          workItemId: primary.workId,
          resourceKey,
          cancelledCount: cancelled.length,
          cancelledByLogin: attribution.login,
          force: true,
          ...deferredCorrelation(ctx.correlation),
        },
      });
    }
  }
  if (slashActiveConflictWorkId(ctx, "review") !== undefined) {
    enqueueSlashAck(ctx, {
      ...(cancelProgress !== undefined ? { cancelProgress } : {}),
      reply: { target: ctx.input.replyTarget, body: SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY },
    });
    return;
  }
  const workItemId = randomUUID();
  insertWorkRun(ctx.db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "review",
    payloadJson: runPayload(ctx.ref, "slash", ctx.eventId, ctx.input.headers, ctx.now, {
      mode: "review",
      reviewLens: "review",
      userSupplement: clampStoredCommentText(`User invoked /review with:\n${ctx.input.body}`),
      commenterId: ctx.input.commenterId,
      ackTargets: ctx.targets,
    }),
    now: ctx.now,
  });
  setActiveReview(ctx.db, resourceKey, workItemId, "slash", ctx.now);
  transferProgressCommentOwnership(ctx.db, { workItemId, resourceKey, now: ctx.now });
  enqueueSlashAck(ctx, {
    workItemId,
    progress: { lens: "review", headSha: ctx.ref.headSha, source: "slash" },
    ...(cancelProgress !== undefined ? { cancelProgress } : {}),
    ...(cancelProgress !== undefined
      ? { reply: { target: ctx.input.replyTarget, body: SLASH_REVIEW_FORCE_RESTARTED_BODY } }
      : {}),
  });
  approveAwaiting(ctx.db, resourceKey, "slash", undefined, ctx.now);
  ctx.sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "review",
      source: "slash",
      workItemId,
      resourceKey,
      lens: "review",
      force,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function handleSlashCancel(ctx: SlashContext) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const attribution = {
    kind: "user" as const,
    login: sanitizeGithubLogin(ctx.input.commenterLogin ?? ""),
  };
  const cancelled = cancelActiveRunsOfKind(
    ctx.db,
    resourceKey,
    "review",
    attribution,
    ctx.input.prNumber,
    ctx.now,
  );
  for (const run of cancelled) {
    if (run.conversationId !== undefined) ctx.sink.conversationsToAbort.push(run.conversationId);
  }
  ctx.sink.events.push(
    ...workLifecycleEvents(
      ctx.ref,
      cancelled.map((row) => ({
        workId: row.workId,
        headSha: row.headSha,
        source: row.source,
        workType: "review",
        lifecycleStatus: "cancelled",
      })),
      "slash_cancel",
      ctx.correlation,
    ),
  );
  if (cancelled.length === 0) {
    enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: SLASH_CANCEL_NONE_BODY },
    });
    ctx.sink.events.push({
      name: "ignored_slash_cancel_no_active_review",
      fields: { resourceKey },
    });
    return;
  }
  const primary = cancelled[0];
  if (primary == null) return;
  enqueueSlashAck(ctx, {
    cancelProgress: {
      workItemId: primary.workId,
      cancelledWorkItemIds: cancelled.map((row) => row.workId),
      attribution,
    },
    reply: { target: ctx.input.replyTarget, body: SLASH_CANCEL_DONE_BODY },
  });
  ctx.sink.events.push({
    name: "agent_work_cancel_requested",
    fields: {
      type: "review",
      source: "slash",
      workItemId: primary.workId,
      resourceKey,
      cancelledCount: cancelled.length,
      cancelledByLogin: attribution.login,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function handleSlashVerify(ctx: SlashContext) {
  const resourceKey = prResourceKey(ctx.input.owner, ctx.input.repo, ctx.input.prNumber);
  const active = readRow(
    ctx.db
      .prepare(
        `SELECT work_id FROM work_runs
         WHERE pr_key = ? AND kind = 'verification' AND status IN ${ACTIVE_RUN_STATUSES}
         LIMIT 1`,
      )
      .get(resourceKey),
    workIdRowSchema,
  );
  if (active !== undefined) {
    enqueueSlashAck(ctx, {
      reply: { target: ctx.input.replyTarget, body: SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY },
    });
    return;
  }
  const workItemId = randomUUID();
  insertWorkRun(ctx.db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "verification",
    payloadJson: runPayload(ctx.ref, "slash", ctx.eventId, ctx.input.headers, ctx.now, {
      ackTargets: ctx.targets,
    }),
    now: ctx.now,
  });
  enqueueSlashAck(ctx, { workItemId });
  ctx.sink.events.push({
    name: "agent_work_enqueued",
    fields: {
      type: "verification",
      source: "slash",
      workItemId,
      resourceKey,
      ...deferredCorrelation(ctx.correlation),
    },
  });
}

function handleSlashUnknown(ctx: SlashContext, command: string) {
  enqueueSlashAck(ctx, {
    reply: {
      target: ctx.input.replyTarget,
      body: `Unknown command \`/${command}\`. Run \`/help\` for available commands.`,
    },
  });
  ctx.sink.events.push({
    name: "ignored_unknown_slash_command",
    fields: { command },
  });
}

function handleSlashHelp(ctx: SlashContext) {
  enqueueSlashAck(ctx, {
    reply: {
      target: ctx.input.replyTarget,
      body: slashHelpBody(ctx.features.reviewCadence),
    },
  });
}

type SlashIntakeHandler = (ctx: SlashContext) => void;

const SLASH_INTAKE_HANDLERS: Record<string, SlashIntakeHandler> = {
  help: handleSlashHelp,
  ask: promoteAsk,
  describe: handleSlashDescribe,
  triage: handleSlashTriage,
  review: handleSlashReview,
  cancel: handleSlashCancel,
  verify: handleSlashVerify,
};

function applySlashCommandIntake(
  db: DatabaseSync,
  sink: IntakeSink,
  input: SlashCommandInput,
  features: IntakeFeatures,
  askQuota: AskQuotaConfig,
  now: number,
) {
  const command = input.command;
  let reviewRefused: "closed" | "merged" | undefined;
  const resourceKey = prResourceKey(input.owner, input.repo, input.prNumber);
  if (command === "review") {
    const lifecycle = loadPrState(db, resourceKey);
    if (lifecycle !== undefined && lifecycle.lifecycle_state !== "open") {
      reviewRefused = lifecycle.lifecycle_state === "merged" ? "merged" : "closed";
    }
  }
  const event = insertWebhookEvent(
    db,
    input.headers,
    reviewRefused == null ? `slash_${command}` : `ignored_slash_review_pr_${reviewRefused}`,
    now,
  );
  if (event.duplicate) {
    sink.events.push({
      name: "deduped_delivery",
      fields: { dedupeKey: event.dedupeKey, event: input.headers.event },
    });
    return;
  }
  const correlation = jobCorrelation(event.id, input.headers);
  const ref: PrRef = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    installationId: input.installationId,
    headSha: DEFERRED_HEAD_SHA,
    ...(input.repositorySizeKb !== undefined ? { repositorySizeKb: input.repositorySizeKb } : {}),
  };
  const targets: AckTarget[] = [
    { kind: "pr", prNumber: input.prNumber },
    input.replyTarget.kind === "prConversation"
      ? { kind: "issueComment", commentId: input.commentId }
      : { kind: "reviewComment", commentId: input.commentId },
  ];
  const ctx: SlashContext = {
    db,
    sink,
    input,
    eventId: event.id,
    correlation,
    ref,
    targets,
    askQuota,
    features,
    ...(reviewRefused !== undefined ? { reviewRefused } : {}),
    now,
  };
  const handler = SLASH_INTAKE_HANDLERS[command];
  if (!handler) {
    handleSlashUnknown(ctx, command);
    return;
  }
  const disabledByFeature: Record<string, boolean> = {
    ask: features.ask === "off",
    describe: features.describe === "off",
    triage: features.triage === "off",
    verify: features.verification === "off",
  };
  if (disabledByFeature[command]) {
    enqueueSlashAck(ctx, {
      reply: { target: input.replyTarget, body: slashDisabledBody(command) },
    });
    sink.events.push({ name: "ignored_disabled_slash_command", fields: { command } });
    return;
  }
  handler(ctx);
}

const ONCE_CADENCE_NOTE =
  "What runs automatically depends on the `FEATURE_*` settings (see docs/features.md). Review and describe fire on PR open in `auto` mode; later pushes need a manual `/review`.";

const EVERY_PUSH_CADENCE_NOTE =
  "What runs automatically depends on the `FEATURE_*` settings, see docs/features.md. Review and describe fire on PR open in `auto` mode. With `FEATURE_REVIEW_CADENCE=every_push`, each later push to an open admitted pull request starts a review. A running `/review` finishes, and one follow-up then reviews the newest head.";

function slashHelpBody(reviewCadence: IntakeFeatures["reviewCadence"]) {
  return ((pinnedReturn: string) => pinnedReturn)(
    slashHelpLines(reviewCadence === "every_push" ? EVERY_PUSH_CADENCE_NOTE : ONCE_CADENCE_NOTE),
  );
}

function slashHelpLines(cadenceNote: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      "### PR Agent help",
      "",
      "Commands (first line of a **new** comment):",
      "- `/help` - show this message",
      "- `/ask <question>` - ask about this PR or a specific line (or mention the App bot for the same Q&A)",
      "- `/describe` - write the PR Agent description block (also runs when a PR opens). Title rewrite is on by default; set FEATURE_TITLE_REWRITE=false to keep the existing title",
      "- `/review` - review the PR for bugs (also runs when a PR opens in `auto`, or in `approval` mode for trusted authors and after maintainer approval for forks)",
      "- `/review force` - cancel any queued or in-progress review and start a new one on the latest commit",
      "- `/cancel` - cancel a queued or in-progress review on this PR",
      "- `/triage` - fix earlier PR Agent findings on this PR. Post on the conversation for all findings, or reply `/triage` inside one finding thread for that finding only.",
      "- `/triage preview` - render the would-be unified diff for eligible findings. No commits, no push.",
      "- `/triage all` - apply the previewed set (one commit per finding). Optional `exclude <thread ids>`. Refused without a matching `/triage preview` on this head.",
      "- `/verify` - verify open findings against the current pull request head",
      "",
      "Notes:",
      `- ${cadenceNote}`,
      "- `/describe` writes in the PR Agent description block and keeps your text outside it.",
      "- `/ask` and App-bot mentions load the shared discussion. They do not change finding severity, dismiss a finding, or edit a review summary.",
      "- `/cancel` stops the active review immediately and updates the progress stub with who cancelled it.",
      "- Edited comments are ignored for slash parsing in v1.",
    ].join("\n"),
  );
}

const SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY =
  "A `/review` run is already queued or in progress for this pull request.";

const SLASH_REVIEW_FORCE_RESTARTED_BODY =
  "Cancelled the previous review and started a new one on the latest commit.";

const SLASH_CANCEL_NONE_BODY = "No review is queued or in progress for this pull request.";

const SLASH_CANCEL_DONE_BODY = "Cancelled the in-progress review.";

const SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY =
  "A `/verify` run is already queued or in progress for this pull request.";

function slashDisabledBody(command: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `\`/${command}\` is disabled on this deployment (\`FEATURE_*\` settings; see docs/features.md).`,
  );
}

export function runDelivery(
  db: DatabaseSync,
  cfg: { readonly features: IntakeFeatures; readonly ask?: Partial<AskQuotaConfig> },
  command: IntakeCommand,
  now = Date.now(),
) {
  const sink: IntakeSink = { events: [], conversationsToAbort: [] };
  immediate(db, () => {
    switch (command.kind) {
      case "ignored":
        insertWebhookEvent(db, command.headers, command.decision, now);
        break;
      case "pull_request":
        applyAutomatedPullRequestIntake(db, sink, command, cfg.features, now);
        break;
      case "review_approved":
        applyReviewApprovedIntake(db, sink, command.headers, command.signal, now);
        break;
      case "ci_refresh":
        applyCompletedRunCiIntake(db, sink, command.headers, command.data, now);
        break;
      case "ci_state":
        applyCiStateIntake(db, sink, command.headers, command.data, now);
        break;
      case "slash":
        applySlashCommandIntake(
          db,
          sink,
          command.input,
          cfg.features,
          resolveAskQuotaConfig(cfg.ask),
          now,
        );
        break;
      case "verification_reply":
        applyVerificationReplyIntake(db, sink, command.headers, command, now);
        break;
      default:
        command satisfies never;
        throw new Error("Unknown intake command");
    }
  });
  return ((pinnedReturn: DeliveryResult) => pinnedReturn)({
    events: sink.events,
    conversationsToAbort: sink.conversationsToAbort,
  });
}
