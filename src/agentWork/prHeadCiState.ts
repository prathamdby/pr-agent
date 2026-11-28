import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.ts";
import * as v from "valibot";
import { isRecord } from "../util/typeGuards.ts";
import {
  applyCiCheckFact,
  canonicalizeCiCheckFacts,
  ciCheckFactSchema,
  classifySnapshot,
  isCheckFactPending,
  mergeGithubSnapshotIntoChecks,
  type CiCheckFact,
  type CiRollup,
  type CiAuthoredCache,
  type CiCheckRunSnapshot,
  type CiLegacyStatus,
  type CiSourceAvailability,
} from "../review/ci/ciFacts.ts";
import {
  CI_STATE_MAX_CHECKS,
  DEFERRED_HEAD_SHA,
  RETENTION_DELETE_BATCH_SIZE,
} from "../settings/index.ts";

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
  readonly projectionRepairPending: boolean;
  readonly firstSeenAt: Date;
  readonly updatedAt: Date;
  readonly sourceAvailability?: CiSourceAvailability;
};

export function headCiNeedsSeed(row: Pick<PrHeadCiStateRow, "seededAt"> | null) {
  return ((pinnedReturn: boolean) => pinnedReturn)(row == null || row.seededAt == null);
}

export type HeadCiListingPhase = "seed" | "pending-refresh" | "none";
const UNKNOWN_CI_READ_LIMIT = 3;

export function headCiListingPhase(
  row: Pick<PrHeadCiStateRow, "seededAt" | "checks" | "rollup" | "sourceAvailability"> | null,
) {
  if (row?.sourceAvailability != null) {
    const availability = row.sourceAvailability;
    const needsListing = (["checks", "statuses"] as const).some((source) => {
      const state = availability[source];
      if (state.access === "denied") return false;
      if (state.access === "unknown" && (state.unknownReadCount ?? 0) >= UNKNOWN_CI_READ_LIMIT)
        return false;
      return (
        state.access === "unknown" ||
        state.listingRequired ||
        Object.values(row.checks).some(
          (fact) =>
            fact.source === (source === "checks" ? "check_run" : "status") &&
            isCheckFactPending(fact),
        )
      );
    });
    if (!needsListing) return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("none");
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)(
      row.seededAt == null ? "seed" : "pending-refresh",
    );
  }
  if (row == null || row.seededAt == null)
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("seed");
  if (row.rollup === "unknown")
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("pending-refresh");
  if (Object.values(row.checks).some(isCheckFactPending))
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("pending-refresh");
  return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("none");
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

export type RefreshPrHeadCiStateResult = {
  readonly row: PrHeadCiStateRow;
  readonly previousRollup: CiRollup;
};

type LockedCiStateRow = {
  readonly checks: Record<string, CiCheckFact>;
  readonly truncated: boolean;
  readonly version: string | number;
  readonly rollup: string;
};

function asRollup(value: unknown) {
  switch (value) {
    case "pending":
    case "passing":
    case "failing":
    case "none":
    case "unknown":
      return ((pinnedReturn: CiRollup) => pinnedReturn)(value);
    default:
      return ((pinnedReturn: CiRollup) => pinnedReturn)("unknown");
  }
}

const checkMapSchema = v.record(v.string(), ciCheckFactSchema);

function asCheckMap(value: unknown) {
  if (!isRecord(value)) return ((pinnedReturn: Record<string, CiCheckFact>) => pinnedReturn)({});
  v.assert(checkMapSchema, value);
  return ((pinnedReturn: Record<string, CiCheckFact>) => pinnedReturn)(
    canonicalizeCiCheckFacts(value),
  );
}

export async function applyPrHeadCiFact(client: PoolClient, input: ApplyPrHeadCiFactInput) {
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
    throw new AppError({
      domain: "ci",
      kind: "head_state_lock_missed",
      message: "pr_head_ci_state lock missed after insert",
    });
  }
  const currentChecks = asCheckMap(row.checks);
  const previousRollup = asRollup(row.rollup);
  const merged = applyCiCheckFact(currentChecks, input.fact, CI_STATE_MAX_CHECKS);
  const currentVersion = Number(row.version);
  if (!merged.accepted) {
    return ((pinnedReturn: ApplyPrHeadCiFactResult | Promise<ApplyPrHeadCiFactResult>) =>
      pinnedReturn)({
      accepted: false,
      version: currentVersion,
      previousRollup,
      rollup: previousRollup,
    });
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
  return ((pinnedReturn: ApplyPrHeadCiFactResult | Promise<ApplyPrHeadCiFactResult>) =>
    pinnedReturn)({ accepted: true, version: nextVersion, previousRollup, rollup });
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
  readonly projection_repair_pending: boolean;
  readonly first_seen_at: Date;
  readonly updated_at: Date;
};

export async function loadPrHeadCiState(
  db: Pool | PoolClient,
  owner: string,
  repo: string,
  headSha: string,
) {
  const result = await db.query<LoadedCiStateRow>(
    `SELECT owner, repo, head_sha, checks, rollup, version, authored, pr_numbers,
            truncated, seeded_at, projection_repair_pending, first_seen_at, updated_at
       FROM pr_head_ci_state
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [owner, repo, headSha],
  );
  const row = result.rows[0];
  if (row == null)
    return ((pinnedReturn: (PrHeadCiStateRow | null) | Promise<PrHeadCiStateRow | null>) =>
      pinnedReturn)(null);
  return ((pinnedReturn: (PrHeadCiStateRow | null) | Promise<PrHeadCiStateRow | null>) =>
    pinnedReturn)(mapLoadedRow(row));
}

export function asPrNumbers(value: unknown) {
  if (!Array.isArray(value)) return ((pinnedReturn: number[]) => pinnedReturn)([]);
  const numbers: number[] = [];
  for (const entry of value) {
    const n = typeof entry === "number" ? entry : Number(entry);
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return ((pinnedReturn: number[]) => pinnedReturn)(numbers);
}

export async function listPrNumbersForHeadFromWorkItems(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
) {
  const result = await pool.query<{ pr_number: number }>(
    `SELECT DISTINCT pr_number
       FROM agent_work_items
      WHERE owner = $1 AND repo = $2 AND head_sha = $3 AND head_sha <> $4
      ORDER BY pr_number`,
    [owner, repo, headSha, DEFERRED_HEAD_SHA],
  );
  return ((pinnedReturn: number[] | Promise<number[]>) => pinnedReturn)(
    result.rows.map((row) => row.pr_number),
  );
}

export async function newestHeadShaForResource(pool: Pool, resourceKey: string) {
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
  return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(
    result.rows[0]?.head_sha ?? null,
  );
}

export async function storePrHeadCiAuthored(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
  authored: CiAuthoredCache,
) {
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
) {
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
) {
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
  return ((
    pinnedReturn: readonly TerminalReviewForHead[] | Promise<readonly TerminalReviewForHead[]>,
  ) => pinnedReturn)(
    result.rows.flatMap((row) => {
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
    }),
  );
}

type GithubSnapshotWriteInput = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly checkRuns: readonly CiCheckRunSnapshot[];
  readonly legacyStatuses: readonly CiLegacyStatus[];
  readonly githubAppId: string;
  readonly checkRunsComplete?: boolean;
};

function mergeLockedGithubSnapshot(
  row: LoadedCiStateRow,
  input: GithubSnapshotWriteInput,
  mode: "initial-seed" | "pending-refresh",
) {
  return mergeGithubSnapshotIntoChecks({
    stored: asCheckMap(row.checks),
    storedTruncated: row.truncated,
    checkRuns: input.checkRuns,
    legacyStatuses: input.legacyStatuses,
    identity: { githubAppId: input.githubAppId },
    checkRunsComplete: input.checkRunsComplete,
    maxChecks: CI_STATE_MAX_CHECKS,
    mode,
  });
}

export async function seedPrHeadCiStateFromSnapshot(pool: Pool, input: GithubSnapshotWriteInput) {
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
              truncated, seeded_at, projection_repair_pending, first_seen_at, updated_at
         FROM pr_head_ci_state
        WHERE owner = $1 AND repo = $2 AND head_sha = $3
        FOR UPDATE`,
      [input.owner, input.repo, input.headSha],
    );
    const row = locked.rows[0];
    if (row == null) {
      throw new AppError({
        domain: "ci",
        kind: "head_state_lock_missed",
        message: "pr_head_ci_state lock missed after seed insert",
      });
    }
    if (row.seeded_at != null) {
      await client.query("COMMIT");
      const mapped = mapLoadedRow(row);
      return ((pinnedReturn: SeedPrHeadCiStateResult | Promise<SeedPrHeadCiStateResult>) =>
        pinnedReturn)({ row: mapped, previousRollup: mapped.rollup });
    }
    const merged = mergeLockedGithubSnapshot(row, input, "initial-seed");
    previousRollup = asRollup(row.rollup);
    const nextVersion = Number(row.version) + 1;
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
        JSON.stringify(merged.checks),
        merged.rollup,
        nextVersion,
        merged.truncated,
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
    throw new AppError({
      domain: "ci",
      kind: "head_state_missing",
      message: "pr_head_ci_state missing after seed",
    });
  }
  return ((pinnedReturn: SeedPrHeadCiStateResult | Promise<SeedPrHeadCiStateResult>) =>
    pinnedReturn)({ row: seeded, previousRollup });
}

export async function refreshPrHeadCiFromGithubSnapshot(
  pool: Pool,
  input: GithubSnapshotWriteInput,
) {
  const client = await pool.connect();
  let previousRollup: CiRollup = "none";
  let materialChange = false;
  try {
    await client.query("BEGIN");
    const locked = await client.query<LoadedCiStateRow>(
      `SELECT owner, repo, head_sha, checks, rollup, version, authored, pr_numbers,
              truncated, seeded_at, projection_repair_pending, first_seen_at, updated_at
         FROM pr_head_ci_state
        WHERE owner = $1 AND repo = $2 AND head_sha = $3
        FOR UPDATE`,
      [input.owner, input.repo, input.headSha],
    );
    const row = locked.rows[0];
    if (row == null) {
      throw new AppError({
        domain: "ci",
        kind: "head_state_missing",
        message: "pr_head_ci_state missing for pending refresh",
      });
    }
    if (row.seeded_at == null) {
      throw new AppError({
        domain: "ci",
        kind: "head_state_unseeded",
        message: "pr_head_ci_state is unseeded for pending refresh",
      });
    }
    previousRollup = asRollup(row.rollup);
    const merged = mergeLockedGithubSnapshot(row, input, "pending-refresh");
    materialChange = merged.materialChange;
    const rollupChanged = merged.rollup !== previousRollup;
    const truncatedChanged = merged.truncated !== row.truncated;
    if (!materialChange && !rollupChanged && !truncatedChanged) {
      await client.query("COMMIT");
      return ((pinnedReturn: RefreshPrHeadCiStateResult | Promise<RefreshPrHeadCiStateResult>) =>
        pinnedReturn)({
        row: mapLoadedRow(row),
        previousRollup,
      });
    }
    const nextVersion =
      materialChange || rollupChanged ? Number(row.version) + 1 : Number(row.version);
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
        merged.rollup,
        nextVersion,
        merged.truncated,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const refreshed = await loadPrHeadCiState(pool, input.owner, input.repo, input.headSha);
  if (refreshed == null) {
    throw new AppError({
      domain: "ci",
      kind: "head_state_missing",
      message: "pr_head_ci_state missing after pending refresh",
    });
  }
  return ((pinnedReturn: RefreshPrHeadCiStateResult | Promise<RefreshPrHeadCiStateResult>) =>
    pinnedReturn)({ row: refreshed, previousRollup });
}

function mapLoadedRow(row: LoadedCiStateRow) {
  return ((pinnedReturn: PrHeadCiStateRow) => pinnedReturn)({
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
    projectionRepairPending: row.projection_repair_pending,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  });
}

export type VerificationSignalPrior = {
  readonly active: boolean;
  readonly headSha: string | null;
};

export function isEffectiveVerificationSignalTransition(
  prior: VerificationSignalPrior | null,
  next: { readonly active: boolean; readonly headSha: string },
) {
  const wasActive = prior?.active === true;
  if (next.active) {
    if (!wasActive) return ((pinnedReturn: boolean) => pinnedReturn)(true);
    return ((pinnedReturn: boolean) => pinnedReturn)(prior?.headSha !== next.headSha);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(wasActive && prior?.headSha === next.headSha);
}

export async function advancePrHeadCiRevisionForVerificationSignal(
  client: PoolClient,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly effective: boolean;
  },
) {
  await client.query(
    `INSERT INTO pr_head_ci_state (owner, repo, head_sha, checks, rollup, version)
     VALUES ($1, $2, $3, '{}'::jsonb, 'none', 0)
     ON CONFLICT (owner, repo, head_sha) DO NOTHING`,
    [input.owner, input.repo, input.headSha],
  );
  const locked = await client.query<{ version: string | number }>(
    `SELECT version
       FROM pr_head_ci_state
      WHERE owner = $1 AND repo = $2 AND head_sha = $3
      FOR UPDATE`,
    [input.owner, input.repo, input.headSha],
  );
  const row = locked.rows[0];
  if (row == null) {
    throw new AppError({
      domain: "ci",
      kind: "head_state_lock_missed",
      message: "pr_head_ci_state lock missed after verification revision insert",
    });
  }
  const currentVersion = Number(row.version);
  if (!input.effective) {
    return ((
      pinnedReturn:
        | { readonly version: number; readonly bumped: boolean }
        | Promise<{ readonly version: number; readonly bumped: boolean }>,
    ) => pinnedReturn)({ version: currentVersion, bumped: false });
  }
  const nextVersion = currentVersion + 1;
  await client.query(
    `UPDATE pr_head_ci_state
        SET version = $4,
            updated_at = now()
      WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
    [input.owner, input.repo, input.headSha, nextVersion],
  );
  return ((
    pinnedReturn:
      | { readonly version: number; readonly bumped: boolean }
      | Promise<{ readonly version: number; readonly bumped: boolean }>,
  ) => pinnedReturn)({ version: nextVersion, bumped: true });
}

export type ProjectionRepairCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly version: number;
  readonly installationId: number | null;
};

export async function listProjectionRepairPendingHeads(pool: Pool, limit: number) {
  const result = await pool.query<{
    owner: string;
    repo: string;
    head_sha: string;
    version: string | number;
    installation_id: string | number | null;
  }>(
    `SELECT s.owner, s.repo, s.head_sha, s.version,
            COALESCE((
              SELECT c.installation_id
                FROM github_head_ci_sources c
                JOIN github_repository_capabilities o
                  ON o.installation_id = c.installation_id AND o.owner = c.owner AND o.repo = c.repo
               WHERE c.owner = s.owner AND c.repo = s.repo AND c.head_sha = s.head_sha
                 AND (c.generation < o.generation OR (
                   c.generation = o.generation AND c.access <> 'denied'
                   AND o.capabilities->>(CASE c.source WHEN 'checks' THEN 'checksRead' ELSE 'statusesRead' END) = 'denied'
                 ))
               ORDER BY c.installation_id LIMIT 1
            ), (
              SELECT w.installation_id
                FROM agent_work_items w
               WHERE w.owner = s.owner
                 AND w.repo = s.repo
                 AND w.head_sha = s.head_sha
               ORDER BY w.created_at DESC
               LIMIT 1
            )) AS installation_id
       FROM pr_head_ci_state s
      WHERE s.projection_repair_pending = true OR EXISTS (
        SELECT 1 FROM github_head_ci_sources c
          JOIN github_repository_capabilities o
            ON o.installation_id = c.installation_id AND o.owner = c.owner AND o.repo = c.repo
         WHERE c.owner = s.owner AND c.repo = s.repo AND c.head_sha = s.head_sha
           AND (c.generation < o.generation OR (
             c.generation = o.generation AND c.access <> 'denied'
             AND o.capabilities->>(CASE c.source WHEN 'checks' THEN 'checksRead' ELSE 'statusesRead' END) = 'denied'
           ))
      )
      ORDER BY s.updated_at ASC
      LIMIT $1::int`,
    [limit],
  );
  return ((
    pinnedReturn:
      | readonly ProjectionRepairCandidate[]
      | Promise<readonly ProjectionRepairCandidate[]>,
  ) => pinnedReturn)(
    result.rows.map((row) => ({
      owner: row.owner,
      repo: row.repo,
      headSha: row.head_sha,
      version: Number(row.version),
      installationId:
        row.installation_id == null || Number(row.installation_id) <= 0
          ? null
          : Number(row.installation_id),
    })),
  );
}

export async function clearProjectionRepairPending(
  pool: Pool | PoolClient,
  owner: string,
  repo: string,
  headSha: string,
) {
  const result = await pool.query(
    `UPDATE pr_head_ci_state
        SET projection_repair_pending = false,
            updated_at = now()
      WHERE owner = $1 AND repo = $2 AND head_sha = $3
        AND projection_repair_pending = true`,
    [owner, repo, headSha],
  );
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)((result.rowCount ?? 0) > 0);
}

export async function deleteExpiredPrHeadCiState(pool: Pool, agentWorkRetentionSeconds: number) {
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
  return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(deleted);
}
