import type { Pool, PoolClient } from "pg";
import {
  applyCiCheckFact,
  checkRunSnapshotToFact,
  classifySnapshot,
  isOwnCiCheck,
  legacyStatusToFact,
  type CiCheckFact,
  type CiRollup,
  type OwnCheckIdentity,
} from "../review/ci/classifySnapshot.js";
import type { CiAuthoredCache } from "../review/ci/ciAuthoredCache.js";
import type { CiCheckRunSnapshot, CiLegacyStatus } from "../review/ci/ciSummaryTypes.js";
import {
  CI_STATE_MAX_CHECKS,
  DEFERRED_HEAD_SHA,
  OWN_COMMIT_STATUS_CONTEXT,
  RETENTION_DELETE_BATCH_SIZE,
} from "../settings/index.js";

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

export function headCiNeedsSeed(row: Pick<PrHeadCiStateRow, "seededAt"> | null): boolean {
  return row == null || row.seededAt == null;
}

export type ApplyPrHeadCiFactInput = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly fact: CiCheckFact;
};

export type ApplyPrHeadCiFactResult = {
  readonly accepted: boolean;
  readonly version: number;
  readonly previousRollup: CiRollup;
  readonly rollup: CiRollup;
};

export type SeedPrHeadCiStateResult = {
  readonly row: PrHeadCiStateRow;
  readonly previousRollup: CiRollup;
};

type LockedCiStateRow = {
  readonly checks: Record<string, CiCheckFact>;
  readonly truncated: boolean;
  readonly version: string | number;
  readonly rollup: string;
};

function asRollup(value: unknown): CiRollup {
  switch (value) {
    case "pending":
    case "passing":
    case "failing":
    case "none":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

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
    `SELECT checks, truncated, version, rollup
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
  const previousRollup = asRollup(row.rollup);
  const merged = applyCiCheckFact(currentChecks, input.fact, CI_STATE_MAX_CHECKS);
  const currentVersion = Number(row.version);
  if (!merged.accepted) {
    return {
      accepted: false,
      version: currentVersion,
      previousRollup,
      rollup: previousRollup,
    };
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
  return { accepted: true, version: nextVersion, previousRollup, rollup };
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
  db: Pool | PoolClient,
  owner: string,
  repo: string,
  headSha: string,
): Promise<PrHeadCiStateRow | null> {
  const result = await db.query<LoadedCiStateRow>(
    `SELECT owner, repo, head_sha, checks, rollup, version, authored, pr_numbers,
            truncated, seeded_at, first_seen_at, updated_at
       FROM pr_head_ci_state
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [owner, repo, headSha],
  );
  const row = result.rows[0];
  if (row == null) return null;
  return mapLoadedRow(row);
}

export function asPrNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers: number[] = [];
  for (const entry of value) {
    const n = typeof entry === "number" ? entry : Number(entry);
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

export async function listPrNumbersForHeadFromWorkItems(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
): Promise<number[]> {
  const result = await pool.query<{ pr_number: number }>(
    `SELECT DISTINCT pr_number
       FROM agent_work_items
      WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND head_sha <> $4
      ORDER BY pr_number`,
    [owner, repo, headSha, DEFERRED_HEAD_SHA],
  );
  return result.rows.map((row) => row.pr_number);
}

export async function newestHeadShaForResource(
  pool: Pool,
  resourceKey: string,
): Promise<string | null> {
  const result = await pool.query<{ head_sha: string }>(
    `SELECT head_sha
       FROM agent_work_items
      WHERE resource_key = $1
        AND head_sha IS NOT NULL
        AND head_sha <> $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [resourceKey, DEFERRED_HEAD_SHA],
  );
  return result.rows[0]?.head_sha ?? null;
}

export async function storePrHeadCiAuthored(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
  authored: CiAuthoredCache,
): Promise<void> {
  await pool.query(
    `UPDATE pr_head_ci_state
        SET authored = $4::jsonb,
            updated_at = now()
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [owner, repo, headSha, JSON.stringify(authored)],
  );
}

export async function storePrNumbersForHead(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
  prNumbers: readonly number[],
): Promise<void> {
  if (prNumbers.length === 0) return;
  await pool.query(
    `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version, pr_numbers)
     VALUES ($1, $2, $3, '{}'::jsonb, 'none', 0, $4::jsonb)
     ON CONFLICT (owner, repo, head_sha) DO UPDATE
        SET pr_numbers = $4::jsonb,
            updated_at = now()`,
    [owner, repo, headSha, JSON.stringify(prNumbers)],
  );
}

export type TerminalReviewForHead = {
  readonly id: string;
  readonly status: "completed" | "failed" | "cancelled" | "superseded";
  readonly resourceKey: string;
  readonly reviewLens: string;
  readonly prNumber: number;
  readonly headSha: string;
};

export async function listTerminalReviewsForHead(
  pool: Pool,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<readonly TerminalReviewForHead[]> {
  const result = await pool.query<{
    id: string;
    status: TerminalReviewForHead["status"];
    resource_key: string;
    review_lens: string | null;
    pr_number: number;
    head_sha: string;
  }>(
    `SELECT id, status, resource_key, review_lens, pr_number, head_sha
       FROM agent_work_items
      WHERE owner = $1
        AND repo = $2
        AND pr_number = $3
        AND head_sha = $4
        AND type = 'review'
        AND status IN ('completed', 'failed', 'cancelled', 'superseded')`,
    [owner, repo, prNumber, headSha],
  );
  return result.rows.flatMap((row) => {
    if (row.review_lens == null) return [];
    return [
      {
        id: row.id,
        status: row.status,
        resourceKey: row.resource_key,
        reviewLens: row.review_lens,
        prNumber: row.pr_number,
        headSha: row.head_sha,
      },
    ];
  });
}

function snapshotFacts(
  checkRuns: readonly CiCheckRunSnapshot[],
  legacyStatuses: readonly CiLegacyStatus[],
  identity: OwnCheckIdentity,
): CiCheckFact[] {
  const facts: CiCheckFact[] = [];
  for (const run of checkRuns) {
    const fact = checkRunSnapshotToFact(run);
    if (isOwnCiCheck(identity, fact)) continue;
    facts.push(fact);
  }
  for (const status of legacyStatuses) {
    if (status.context === OWN_COMMIT_STATUS_CONTEXT) continue;
    facts.push(legacyStatusToFact(status));
  }
  return facts;
}

export async function seedPrHeadCiStateFromSnapshot(
  pool: Pool,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly checkRuns: readonly CiCheckRunSnapshot[];
    readonly legacyStatuses: readonly CiLegacyStatus[];
    readonly githubAppId: string;
    readonly checkRunsComplete?: boolean;
  },
): Promise<SeedPrHeadCiStateResult> {
  const client = await pool.connect();
  let previousRollup: CiRollup = "none";
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version)
       VALUES ($1, $2, $3, '{}'::jsonb, 'none', 0)
       ON CONFLICT (owner, repo, head_sha) DO NOTHING`,
      [input.owner, input.repo, input.headSha],
    );
    const locked = await client.query<LoadedCiStateRow>(
      `SELECT owner, repo, head_sha, checks, rollup, version, authored, pr_numbers,
              truncated, seeded_at, first_seen_at, updated_at
         FROM pr_head_ci_state
        WHERE owner = $1 AND repo = $2 AND head_sha = $3
        FOR UPDATE`,
      [input.owner, input.repo, input.headSha],
    );
    const row = locked.rows[0];
    if (row == null) {
      throw new Error("pr_head_ci_state lock missed after seed insert");
    }
    if (row.seeded_at != null) {
      await client.query("COMMIT");
      const mapped = mapLoadedRow(row);
      return { row: mapped, previousRollup: mapped.rollup };
    }
    let checks = asCheckMap(row.checks);
    let truncated = row.truncated;
    let acceptedAny = false;
    for (const fact of snapshotFacts(input.checkRuns, input.legacyStatuses, {
      githubAppId: input.githubAppId,
    })) {
      const merged = applyCiCheckFact(checks, fact, CI_STATE_MAX_CHECKS);
      if (!merged.accepted) continue;
      checks = merged.checks;
      truncated = truncated || merged.truncated;
      acceptedAny = true;
    }
    previousRollup = asRollup(row.rollup);
    let rollup = classifySnapshot(Object.values(checks));
    if (input.checkRunsComplete === false && (rollup === "none" || rollup === "passing")) {
      rollup = "unknown";
    }
    const nextVersion =
      acceptedAny || rollup !== previousRollup ? Number(row.version) + 1 : Number(row.version);
    await client.query(
      `UPDATE pr_head_ci_state
          SET checks = $4::jsonb,
              rollup = $5,
              version = $6,
              truncated = $7,
              seeded_at = now(),
              updated_at = now()
        WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
      [
        input.owner,
        input.repo,
        input.headSha,
        JSON.stringify(checks),
        rollup,
        nextVersion,
        truncated,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const seeded = await loadPrHeadCiState(pool, input.owner, input.repo, input.headSha);
  if (seeded == null) {
    throw new Error("pr_head_ci_state missing after seed");
  }
  return { row: seeded, previousRollup };
}

function mapLoadedRow(row: LoadedCiStateRow): PrHeadCiStateRow {
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
