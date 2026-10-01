import type { Pool, PoolClient } from "pg";
import { acquireAutoWorkIntakeLock } from "../autoWorkEnqueue.js";
import { prResourceKey, type PrRef } from "../types.js";
import { loadReviewLifecycle } from "./workItemRepository.js";
import {
  RETENTION_DELETE_BATCH_SIZE,
  WORKFLOW_APPROVAL_HOLD_TTL_SECONDS,
} from "../../settings/index.js";

type AdmissionVia = "author" | "workflow" | "review" | "slash" | "legacy_review";
type AdmissionResult =
  | { readonly admittedHead: string }
  | "already_admitted"
  | "missing"
  | "awaiting_open"
  | "closed"
  | "merged"
  | "head_changed";
type AdmissionHead = Pick<PrRef, "owner" | "repo" | "headSha">;

export async function isHeadAwaitingReviewAdmission(
  pool: Pool,
  head: AdmissionHead,
): Promise<boolean> {
  const result = await pool.query<{ awaiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pr_review_admission
        WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND state = 'pending'
     ) AS awaiting`,
    [head.owner, head.repo, head.headSha],
  );
  return result.rows[0]?.awaiting ?? false;
}

/** Both discovery sides lock the head before the PR, preventing a missing-row lost wakeup. */
export async function acquireReviewAdmissionHeadLock(
  client: PoolClient,
  head: AdmissionHead,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify(["review_admission_head", head.owner, head.repo, head.headSha]),
  ]);
}

export async function recordPending(
  client: PoolClient,
  ref: PrRef,
  authorId: number | undefined,
  eventId: string,
  headObservedAt?: string,
  openedSeen = true,
): Promise<void> {
  await client.query(
    `INSERT INTO pr_review_admission
       (resource_key, owner, repo, pr_number, head_sha, author_id, state, webhook_event_id,
        head_observed_at, opened_seen)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::timestamptz, $9)
     ON CONFLICT (resource_key) DO UPDATE
       SET head_sha = CASE
             WHEN EXCLUDED.head_observed_at > pr_review_admission.head_observed_at
               OR (NOT EXCLUDED.opened_seen
                 AND (pr_review_admission.head_observed_at IS NULL
                   OR EXCLUDED.head_observed_at IS NULL))
             THEN EXCLUDED.head_sha ELSE pr_review_admission.head_sha END,
           head_observed_at = GREATEST(
             pr_review_admission.head_observed_at, EXCLUDED.head_observed_at),
           opened_seen = pr_review_admission.opened_seen OR EXCLUDED.opened_seen,
           author_id = COALESCE(pr_review_admission.author_id, EXCLUDED.author_id),
           webhook_event_id = EXCLUDED.webhook_event_id, updated_at = now()
     WHERE pr_review_admission.state = 'pending'`,
    [
      prResourceKey(ref.owner, ref.repo, ref.prNumber),
      ref.owner,
      ref.repo,
      ref.prNumber,
      ref.headSha,
      authorId ?? null,
      eventId,
      headObservedAt ?? null,
      openedSeen,
    ],
  );
}

export async function updatePendingHead(
  client: PoolClient,
  ref: PrRef,
  eventId: string,
  headObservedAt?: string,
  createIfMissing = true,
): Promise<void> {
  if (createIfMissing) {
    await recordPending(client, ref, undefined, eventId, headObservedAt, false);
    return;
  }
  await client.query(
    `UPDATE pr_review_admission
        SET head_sha = $2, head_observed_at = $3::timestamptz,
            webhook_event_id = $4, updated_at = now()
      WHERE resource_key = $1 AND state = 'pending'
        AND (head_observed_at IS NULL OR head_observed_at <= $3::timestamptz)`,
    [prResourceKey(ref.owner, ref.repo, ref.prNumber), ref.headSha, headObservedAt, eventId],
  );
}

export async function tryAdmit(
  client: PoolClient,
  resourceKey: string,
  via: AdmissionVia,
  by: number | null,
  eventId: string,
  expectedHead?: string,
): Promise<AdmissionResult> {
  await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
  const admission = await client.query<{
    state: "pending" | "admitted";
    head_sha: string;
    opened_seen: boolean;
  }>(
    "SELECT state, head_sha, opened_seen FROM pr_review_admission WHERE resource_key = $1 FOR UPDATE",
    [resourceKey],
  );
  const row = admission.rows[0];
  if (!row) return "missing";
  const lifecycle = await loadReviewLifecycle(client, resourceKey);
  if (lifecycle != null && lifecycle.state !== "open") return lifecycle.state;
  if (row.state === "admitted") return "already_admitted";
  if (via === "workflow" && !row.opened_seen) return "awaiting_open";
  if (expectedHead != null && row.head_sha !== expectedHead) return "head_changed";
  await client.query(
    `UPDATE pr_review_admission
        SET state = 'admitted', admitted_via = $2, admitted_by = $3,
            webhook_event_id = $4, updated_at = now()
      WHERE resource_key = $1`,
    [resourceKey, via, by, eventId],
  );
  return { admittedHead: row.head_sha };
}

export async function recordAuthorAdmitted(
  client: PoolClient,
  ref: PrRef,
  authorId: number | undefined,
  eventId: string,
  headObservedAt?: string,
): Promise<AdmissionResult> {
  await recordPending(client, ref, authorId, eventId, headObservedAt);
  return tryAdmit(
    client,
    prResourceKey(ref.owner, ref.repo, ref.prNumber),
    "author",
    authorId ?? null,
    eventId,
  );
}

export async function recordAwaitingHold(
  client: PoolClient,
  head: AdmissionHead,
  runId: number,
): Promise<void> {
  await client.query(
    `INSERT INTO workflow_run_approval_holds (run_id, owner, repo, head_sha, state)
     VALUES ($1, $2, $3, $4, 'awaiting')
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, head.owner, head.repo, head.headSha],
  );
}

export async function markHoldApproved(
  client: PoolClient,
  head: AdmissionHead,
  runId: number,
  senderId: number,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE workflow_run_approval_holds
        SET state = 'approved', approved_by = COALESCE(approved_by, $5), updated_at = now()
      WHERE run_id = $1 AND owner = $2 AND repo = $3 AND head_sha = $4
        AND observed_at > now() - ($6::bigint * interval '1 second')
      RETURNING run_id`,
    [runId, head.owner, head.repo, head.headSha, senderId, WORKFLOW_APPROVAL_HOLD_TTL_SECONDS],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Workflow holds the head lock; PR-side discovery holds its resource's review lock. */
export async function reconcileForHead(
  client: PoolClient,
  head: AdmissionHead & { readonly installationId: number },
  eventId: string,
  resourceKey?: string,
): Promise<PrRef[]> {
  if (resourceKey != null) {
    const current = await client.query<{ head_sha: string }>(
      "SELECT head_sha FROM pr_review_admission WHERE resource_key = $1 AND state = 'pending'",
      [resourceKey],
    );
    const row = current.rows[0];
    if (!row) return [];
    head = { ...head, headSha: row.head_sha };
  }
  const approved = await client.query<{ approved_by: string }>(
    `SELECT approved_by FROM workflow_run_approval_holds
      WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND state = 'approved'
        AND observed_at > now() - ($4::bigint * interval '1 second')
      ORDER BY observed_at, run_id LIMIT 1`,
    [head.owner, head.repo, head.headSha, WORKFLOW_APPROVAL_HOLD_TTL_SECONDS],
  );
  const hold = approved.rows[0];
  if (!hold) return [];
  const pending = await client.query<{ resource_key: string; pr_number: number }>(
    `SELECT resource_key, pr_number FROM pr_review_admission
      WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND state = 'pending'
        AND ($4::text IS NULL OR resource_key = $4)
      ORDER BY resource_key`,
    [head.owner, head.repo, head.headSha, resourceKey ?? null],
  );
  const admitted: PrRef[] = [];
  for (const row of pending.rows) {
    const result = await tryAdmit(
      client,
      row.resource_key,
      "workflow",
      Number(hold.approved_by),
      eventId,
      head.headSha,
    );
    if (typeof result !== "string") admitted.push({ ...head, prNumber: row.pr_number });
  }
  return admitted;
}

export async function deleteExpiredReviewAdmission(
  pool: Pool,
  retentionSeconds: number,
): Promise<{ reviewAdmissionsDeleted: number; workflowApprovalHoldsDeleted: number }> {
  let reviewAdmissionsDeleted = 0;
  let workflowApprovalHoldsDeleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM pr_review_admission WHERE resource_key IN (
         SELECT admission.resource_key
           FROM pr_review_admission admission
           JOIN pr_review_lifecycle lifecycle USING (resource_key)
          WHERE lifecycle.state IN ('closed', 'merged')
            AND GREATEST(admission.updated_at, lifecycle.updated_at) < now() - ($1::bigint * interval '1 second')
          LIMIT $2::int
          FOR UPDATE OF lifecycle, admission SKIP LOCKED
       )`,
      [retentionSeconds, RETENTION_DELETE_BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    reviewAdmissionsDeleted += batch;
    if (batch < RETENTION_DELETE_BATCH_SIZE) break;
  }
  for (;;) {
    const result = await pool.query(
      `DELETE FROM workflow_run_approval_holds WHERE run_id IN (
         SELECT run_id FROM workflow_run_approval_holds
          WHERE observed_at < now() - ($1::bigint * interval '1 second')
          LIMIT $2::int FOR UPDATE SKIP LOCKED
       )`,
      [WORKFLOW_APPROVAL_HOLD_TTL_SECONDS, RETENTION_DELETE_BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    workflowApprovalHoldsDeleted += batch;
    if (batch < RETENTION_DELETE_BATCH_SIZE) break;
  }
  return { reviewAdmissionsDeleted, workflowApprovalHoldsDeleted };
}
