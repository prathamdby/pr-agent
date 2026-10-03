import type { Pool, PoolClient } from "pg";
import { RETENTION_DELETE_BATCH_SIZE } from "../../settings/index.js";
import { prResourceKey, type PrRef } from "../types.js";

type ApprovalTarget = {
  resource_key: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
};

/** Writes require the review intake lock; head lookup is advisory until approval under that lock. */
export async function insertAwaitingApproval(client: PoolClient, ref: PrRef, eventId: string) {
  const result = await client.query(
    `INSERT INTO pr_review_approvals
       (resource_key, owner, repo, pr_number, head_sha, state, webhook_event_id)
     SELECT $1, $2, $3, $4, $5, 'awaiting', $6
     WHERE NOT EXISTS (
       SELECT 1 FROM agent_work_items WHERE resource_key = $1 AND type = 'review'
     )
     ON CONFLICT DO NOTHING RETURNING resource_key`,
    [
      prResourceKey(ref.owner, ref.repo, ref.prNumber),
      ref.owner,
      ref.repo,
      ref.prNumber,
      ref.headSha,
      eventId,
    ],
  );
  return result.rows.length > 0;
}

export async function moveAwaitingHead(client: PoolClient, resourceKey: string, headSha: string) {
  await client.query(
    `UPDATE pr_review_approvals SET head_sha = $2, updated_at = now()
     WHERE resource_key = $1 AND state = 'awaiting'`,
    [resourceKey, headSha],
  );
}

export async function approveAwaiting(
  client: PoolClient,
  resourceKey: string,
  by: "workflow_run" | "pull_request_review" | "slash",
  headSha?: string,
) {
  const result = await client.query<ApprovalTarget>(
    `UPDATE pr_review_approvals SET state = 'approved', approved_by = $2, updated_at = now()
     WHERE resource_key = $1 AND state = 'awaiting'
       AND ($3::text IS NULL OR head_sha = $3)
     RETURNING resource_key, owner, repo, pr_number, head_sha`,
    [resourceKey, by, headSha ?? null],
  );
  return result.rows[0] ?? null;
}

export async function loadAwaitingApproval(
  client: PoolClient,
  resourceKey: string,
  headSha?: string,
) {
  const result = await client.query<ApprovalTarget>(
    `SELECT resource_key, owner, repo, pr_number, head_sha FROM pr_review_approvals
     WHERE resource_key = $1 AND state = 'awaiting'
       AND ($2::text IS NULL OR head_sha = $2)
     FOR UPDATE`,
    [resourceKey, headSha ?? null],
  );
  return result.rows[0] ?? null;
}

export async function withdrawAwaiting(client: PoolClient, resourceKey: string) {
  const result = await client.query(
    `UPDATE pr_review_approvals SET state = 'withdrawn', updated_at = now()
     WHERE resource_key = $1 AND state = 'awaiting' RETURNING resource_key`,
    [resourceKey],
  );
  return result.rows.length > 0;
}

export async function findAwaitingForHead(
  client: PoolClient,
  owner: string,
  repo: string,
  headSha: string,
) {
  const result = await client.query<ApprovalTarget>(
    `SELECT resource_key, owner, repo, pr_number, head_sha FROM pr_review_approvals
     WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND state = 'awaiting'`,
    [owner, repo, headSha],
  );
  return result.rows;
}

/** Reread under the progress-publication lock so a delayed notice cannot restore waiting over a queued stub. */
export async function canPublishApprovalNotice(
  client: PoolClient,
  resourceKey: string,
  state: "awaiting" | "withdrawn",
) {
  const result = await client.query(
    `SELECT 1 FROM pr_review_approvals a
     WHERE a.resource_key = $1 AND a.state = $2
       AND NOT EXISTS (
         SELECT 1 FROM publish_records p
         WHERE p.resource_key = a.resource_key AND p.step = 'progress_comment'
       )
       AND ($2 = 'awaiting' OR EXISTS (
         SELECT 1 FROM pr_review_lifecycle l WHERE l.resource_key = a.resource_key AND l.state IN ('closed', 'merged')
       ))`,
    [resourceKey, state],
  );
  return result.rows.length > 0;
}

export async function deleteExpiredReviewApprovals(pool: Pool, retentionSeconds: number) {
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM pr_review_approvals
       WHERE resource_key IN (
         SELECT resource_key FROM pr_review_approvals
         WHERE updated_at < now() - ($1::bigint * interval '1 second')
         LIMIT $2::int
       ) AND updated_at < now() - ($1::bigint * interval '1 second')`,
      [retentionSeconds, RETENTION_DELETE_BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    deleted += batch;
    if (batch < RETENTION_DELETE_BATCH_SIZE) return deleted;
  }
}
