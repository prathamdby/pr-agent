import type { Pool, PoolClient } from "pg";
import {
  applyCiCheckFact,
  classifySnapshot,
  type CiCheckFact,
  type CiRollup,
} from "../review/ci/classifySnapshot.js";
import { CI_STATE_MAX_CHECKS, RETENTION_DELETE_BATCH_SIZE } from "../settings/index.js";

export type PrHeadCiStateRow = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly checks: Record<string, CiCheckFact>;
  readonly rollup: CiRollup;
  readonly version: number;
  readonly authored: unknown;
  readonly prNumbers: unknown;
  readonly truncated: boolean;
  readonly seededAt: Date | null;
  readonly firstSeenAt: Date;
  readonly updatedAt: Date;
};

export type ApplyPrHeadCiFactInput = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly fact: CiCheckFact;
};

export type ApplyPrHeadCiFactResult = {
  readonly accepted: boolean;
  readonly version: number;
};

type LockedCiStateRow = {
  readonly checks: Record<string, CiCheckFact>;
  readonly truncated: boolean;
  readonly version: string | number;
};

function asCheckMap(value: unknown): Record<string, CiCheckFact> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, CiCheckFact>;
}

export async function applyPrHeadCiFact(
  client: PoolClient,
  input: ApplyPrHeadCiFactInput,
): Promise<ApplyPrHeadCiFactResult> {
  await client.query(
    `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version)
     VALUES ($1, $2, $3, '{}'::jsonb, 'none', 0)
     ON CONFLICT (owner, repo, head_sha) DO NOTHING`,
    [input.owner, input.repo, input.headSha],
  );
  const locked = await client.query<LockedCiStateRow>(
    `SELECT checks, truncated, version
       FROM pr_head_ci_state
      WHERE owner = $1 AND repo = $2 AND head_sha = $3
      FOR UPDATE`,
    [input.owner, input.repo, input.headSha],
  );
  const row = locked.rows[0];
  if (row == null) {
    throw new Error("pr_head_ci_state lock missed after insert");
  }
  const currentChecks = asCheckMap(row.checks);
  const merged = applyCiCheckFact(currentChecks, input.fact, CI_STATE_MAX_CHECKS);
  const currentVersion = Number(row.version);
  if (!merged.accepted) {
    return { accepted: false, version: currentVersion };
  }
  const rollup = classifySnapshot(Object.values(merged.checks));
  const nextVersion = currentVersion + 1;
  const truncated = row.truncated || merged.truncated;
  await client.query(
    `UPDATE pr_head_ci_state
        SET checks = $4::jsonb,
            rollup = $5,
            version = $6,
            truncated = $7,
            updated_at = now()
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [
      input.owner,
      input.repo,
      input.headSha,
      JSON.stringify(merged.checks),
      rollup,
      nextVersion,
      truncated,
    ],
  );
  return { accepted: true, version: nextVersion };
}

type LoadedCiStateRow = {
  readonly owner: string;
  readonly repo: string;
  readonly head_sha: string;
  readonly checks: unknown;
  readonly rollup: CiRollup;
  readonly version: string | number;
  readonly authored: unknown;
  readonly pr_numbers: unknown;
  readonly truncated: boolean;
  readonly seeded_at: Date | null;
  readonly first_seen_at: Date;
  readonly updated_at: Date;
};

export async function loadPrHeadCiState(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
): Promise<PrHeadCiStateRow | null> {
  const result = await pool.query<LoadedCiStateRow>(
    `SELECT owner, repo, head_sha, checks, rollup, version, authored, pr_numbers,
            truncated, seeded_at, first_seen_at, updated_at
       FROM pr_head_ci_state
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [owner, repo, headSha],
  );
  const row = result.rows[0];
  if (row == null) return null;
  return {
    owner: row.owner,
    repo: row.repo,
    headSha: row.head_sha,
    checks: asCheckMap(row.checks),
    rollup: row.rollup,
    version: Number(row.version),
    authored: row.authored,
    prNumbers: row.pr_numbers,
    truncated: row.truncated,
    seededAt: row.seeded_at,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

export async function deleteExpiredPrHeadCiState(
  pool: Pool,
  agentWorkRetentionSeconds: number,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM pr_head_ci_state
        WHERE (owner, repo, head_sha) IN (
          SELECT s.owner, s.repo, s.head_sha
            FROM pr_head_ci_state s
           WHERE s.updated_at < now() - ($1::bigint * interval '1 second')
             AND NOT EXISTS (
               SELECT 1 FROM agent_work_items w
                WHERE w.owner = s.owner
                  AND w.repo = s.repo
                  AND w.head_sha = s.head_sha
             )
           LIMIT $2::int
        )`,
      [agentWorkRetentionSeconds, RETENTION_DELETE_BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    deleted += batch;
    if (batch < RETENTION_DELETE_BATCH_SIZE) break;
  }
  return deleted;
}
