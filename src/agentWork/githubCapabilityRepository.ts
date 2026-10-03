import type { Pool, PoolClient } from "pg";
import type { CiSourceAccess, CiSourceAvailability } from "../review/ci/ciFacts.js";
import type {
  InstallationCapabilities,
  InstallationOperation,
} from "../github/installationCapabilities.js";
import { RETENTION_DELETE_BATCH_SIZE } from "../settings/index.js";
import { fencedWrite } from "./fencedWrite.js";

export type GithubCapabilityAccess = CiSourceAccess;
export type GithubCapabilities = Partial<InstallationCapabilities["availability"]>;

export type GithubCapabilityObservation = {
  readonly generation: number;
  readonly capabilities: GithubCapabilities;
};

export type GithubRepositoryScope = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
};
export type GithubHeadScope = GithubRepositoryScope & { readonly headSha: string };
export type GithubCiSourceAvailability = CiSourceAvailability & { readonly generation: number };

const sources = ["checks", "statuses"] as const;
const CAPABILITY_FANOUT_BATCH_SIZE = 100;
type Source = (typeof sources)[number];
type SourceRow = {
  source: Source;
  generation: string | number;
  access: CiSourceAccess;
  listing_required: boolean;
  unknown_read_count: number;
};

/** Allocate before provider I/O so completion order cannot overwrite a newer attempt. */
export async function nextGithubCapabilityObservationGeneration(
  db: Pool | PoolClient,
): Promise<string> {
  const result = await db.query<{ generation: string }>(
    "SELECT nextval('github_capability_observation_generation_seq')::text AS generation",
  );
  return result.rows[0].generation;
}

export async function loadGithubCapabilityObservation(
  db: Pool | PoolClient,
  scope: GithubRepositoryScope,
): Promise<GithubCapabilityObservation | null> {
  const result = await db.query<{ generation: string; capabilities: GithubCapabilities }>(
    `SELECT generation, capabilities FROM github_repository_capabilities
      WHERE installation_id = $1 AND owner = $2 AND repo = $3`,
    [scope.installationId, scope.owner, scope.repo],
  );
  const row = result.rows[0];
  return row == null
    ? null
    : { generation: Number(row.generation), capabilities: row.capabilities };
}

/**
 * Repository observations serialize before ordered head locks. CI fact writers
 * only lock heads; no head holder acquires a repository row lock.
 * Fanout touches existing scoped heads only, never historical network state.
 */
export async function saveGithubCapabilityObservation(
  pool: Pool,
  input: GithubRepositoryScope & {
    readonly observation: GithubCapabilityObservation | InstallationCapabilities;
  },
): Promise<boolean> {
  const observation: GithubCapabilityObservation =
    "availability" in input.observation
      ? {
          generation: Number(input.observation.generation),
          capabilities: input.observation.availability,
        }
      : input.observation;
  if (!Number.isSafeInteger(observation.generation) || observation.generation < 0) {
    throw new Error("GitHub capability observation requires an ordered numeric generation");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query<{ generation: string; capabilities: GithubCapabilities }>(
      `INSERT INTO github_repository_capabilities
         (installation_id, owner, repo, generation, capabilities)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (installation_id, owner, repo) DO UPDATE
         SET generation = EXCLUDED.generation,
             capabilities = EXCLUDED.capabilities || COALESCE((
               SELECT jsonb_object_agg(prior.key, prior.value)
                 FROM jsonb_each(github_repository_capabilities.capabilities) prior
                WHERE prior.value = '"denied"'::jsonb
                  AND COALESCE(EXCLUDED.capabilities->>prior.key, 'unknown') = 'unknown'
             ), '{}'::jsonb),
             observed_at = now()
         WHERE github_repository_capabilities.generation < EXCLUDED.generation
       RETURNING generation, capabilities`,
      [
        input.installationId,
        input.owner,
        input.repo,
        observation.generation,
        JSON.stringify(observation.capabilities),
      ],
    );
    if (saved.rowCount === 0) {
      await client.query("COMMIT");
      return false;
    }
    const row = saved.rows[0];
    await fanoutObservation(client, input, {
      generation: Number(row.generation),
      capabilities: row.capabilities,
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Operation-time denial only belongs to the metadata generation that admitted it. */
export async function recordGithubCapabilityDenial(
  pool: Pool,
  input: GithubRepositoryScope & {
    readonly generation: string | number;
    readonly operation: InstallationOperation;
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ generation: string; capabilities: GithubCapabilities }>(
      `UPDATE github_repository_capabilities
          SET capabilities = jsonb_set(capabilities, ARRAY[$5::text], '"denied"'::jsonb),
              observed_at = now()
        WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND generation = $4
          AND capabilities->>$5 IS DISTINCT FROM 'denied'
        RETURNING generation, capabilities`,
      [input.installationId, input.owner, input.repo, input.generation, input.operation],
    );
    const row = result.rows[0];
    if (row != null) {
      await fanoutObservation(client, input, {
        generation: Number(row.generation),
        capabilities: row.capabilities,
      });
    }
    await client.query("COMMIT");
    return row != null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function fanoutObservation(
  client: PoolClient,
  input: GithubRepositoryScope,
  observation: GithubCapabilityObservation,
): Promise<void> {
  const heads = await client.query<{ head_sha: string }>(
    `SELECT h.head_sha FROM pr_head_ci_state h
        WHERE h.owner = $2 AND h.repo = $3
          AND EXISTS (SELECT 1 FROM github_head_ci_sources s
            WHERE s.installation_id = $1 AND s.owner = h.owner AND s.repo = h.repo
              AND s.head_sha = h.head_sha)
        ORDER BY h.head_sha LIMIT $4 FOR UPDATE`,
    [input.installationId, input.owner, input.repo, CAPABILITY_FANOUT_BATCH_SIZE],
  );
  for (const head of heads.rows) {
    await syncSources(client, { ...input, headSha: head.head_sha }, observation);
  }
}

async function syncSources(
  client: PoolClient,
  scope: GithubHeadScope,
  observation: GithubCapabilityObservation | null,
): Promise<void> {
  const generation = observation?.generation ?? 0;
  let changed = false;
  let reopened = false;
  for (const source of sources) {
    const access =
      observation?.capabilities[source === "checks" ? "checksRead" : "statusesRead"] ?? "unknown";
    const result = await client.query<{ changed: boolean; reopened: boolean }>(
      `WITH prior AS (
         SELECT access, unknown_read_count FROM github_head_ci_sources
          WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND head_sha = $4 AND source = $5
       )
       INSERT INTO github_head_ci_sources
         (installation_id, owner, repo, head_sha, source, generation, access)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (installation_id, owner, repo, head_sha, source) DO UPDATE
         SET generation = EXCLUDED.generation, access = EXCLUDED.access,
             listing_required = CASE
               WHEN github_head_ci_sources.access IS DISTINCT FROM EXCLUDED.access THEN true
               ELSE github_head_ci_sources.listing_required END,
             unknown_read_count = 0, updated_at = now()
         WHERE github_head_ci_sources.generation < EXCLUDED.generation
            OR (github_head_ci_sources.generation = EXCLUDED.generation
                AND EXCLUDED.access = 'denied' AND github_head_ci_sources.access <> 'denied')
       RETURNING COALESCE((SELECT access IS DISTINCT FROM $7::text FROM prior), true) AS changed,
                 COALESCE((SELECT access = 'unknown' AND unknown_read_count > 0 FROM prior), false) AS reopened`,
      [scope.installationId, scope.owner, scope.repo, scope.headSha, source, generation, access],
    );
    changed ||= result.rows.some((row) => row.changed);
    reopened ||= result.rows.some((row) => row.reopened);
  }
  if (changed || reopened) {
    await client.query(
      `UPDATE pr_head_ci_state SET version = version + CASE WHEN $4 THEN 1 ELSE 0 END,
          projection_repair_pending = true, updated_at = now()
        WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
      [scope.owner, scope.repo, scope.headSha, changed],
    );
  }
}

/** Lazily reconciles heads outside the bounded observation fanout, atomically. */
export async function loadGithubCiSourceAvailability(
  pool: Pool,
  scope: GithubHeadScope,
): Promise<GithubCiSourceAvailability> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT head_sha FROM pr_head_ci_state WHERE owner = $1 AND repo = $2 AND head_sha = $3 FOR UPDATE`,
      [scope.owner, scope.repo, scope.headSha],
    );
    const observation = await loadGithubCapabilityObservation(client, scope);
    if (locked.rowCount) await syncSources(client, scope, observation);
    const result = await client.query<SourceRow>(
      `SELECT source, generation, access, listing_required, unknown_read_count FROM github_head_ci_sources
        WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
      [scope.installationId, scope.owner, scope.repo, scope.headSha],
    );
    await client.query("COMMIT");
    const sourceState = (source: Source) => {
      const row = result.rows.find((item) => item.source === source);
      return {
        access:
          row?.access ??
          observation?.capabilities[source === "checks" ? "checksRead" : "statusesRead"] ??
          "unknown",
        listingRequired: row?.listing_required ?? true,
        unknownReadCount: row?.unknown_read_count ?? 0,
      };
    };
    return {
      checks: sourceState("checks"),
      statuses: sourceState("statuses"),
      generation: observation?.generation ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A listing begun under an older observation cannot erase a new denial. */
export async function recordGithubCiSourceRead(
  pool: Pool,
  input: GithubHeadScope & {
    readonly source: Source;
    readonly generation: number;
    readonly access: CiSourceAccess;
    readonly complete: boolean;
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT head_sha FROM pr_head_ci_state WHERE owner = $1 AND repo = $2 AND head_sha = $3 FOR UPDATE`,
      [input.owner, input.repo, input.headSha],
    );
    const observation = await loadGithubCapabilityObservation(client, input);
    await syncSources(client, input, observation);
    const updated = await client.query<{ changed: boolean }>(
      `WITH prior AS (
        SELECT access, listing_required FROM github_head_ci_sources
          WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND head_sha = $4
            AND source = $5 AND generation = $8
      )
      UPDATE github_head_ci_sources SET access = $6, listing_required = $7,
          unknown_read_count = CASE WHEN $6 = 'unknown' THEN unknown_read_count + 1 ELSE 0 END,
          updated_at = now()
        WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND head_sha = $4
          AND source = $5 AND generation = $8
          AND NOT (access = 'denied' AND $6 <> 'denied')
          AND ((access, listing_required) IS DISTINCT FROM ($6::text, $7::boolean) OR $6 = 'unknown')
        RETURNING (SELECT (access, listing_required) IS DISTINCT FROM ($6::text, $7::boolean) FROM prior) AS changed`,
      [
        input.installationId,
        input.owner,
        input.repo,
        input.headSha,
        input.source,
        input.access,
        !(input.access === "available" && input.complete),
        input.generation,
      ],
    );
    const changed = updated.rows.some((row) => row.changed);
    if (changed) {
      await client.query(
        `UPDATE pr_head_ci_state SET version = version + 1, updated_at = now()
          WHERE owner = $1 AND repo = $2 AND head_sha = $3`,
        [input.owner, input.repo, input.headSha],
      );
    }
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function changeGithubPreflightFailureCount(
  pool: Pool,
  input: { readonly workItemId: string; readonly leaseEpoch: number; readonly reset?: boolean },
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lease first, as with terminal writes: release cannot race the counter write.
    await client.query(
      `SELECT work_item_id FROM pr_actor_leases
        WHERE work_item_id = $1 AND lease_epoch = $2 FOR UPDATE`,
      [input.workItemId, input.leaseEpoch],
    );
    const count = await fencedWrite(
      client,
      input.workItemId,
      input.leaseEpoch,
      { before: true, rejected: (value: number | null) => value == null },
      async () => {
        const result = await client.query<{ github_preflight_failure_count: number }>(
          `UPDATE agent_work_items
          SET github_preflight_failure_count = CASE WHEN $3 THEN 0 ELSE github_preflight_failure_count + 1 END
        WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL
          AND EXISTS (SELECT 1 FROM pr_actor_leases l WHERE l.work_item_id = $1 AND l.lease_epoch = $2 AND l.expires_at > now())
        RETURNING github_preflight_failure_count`,
          [input.workItemId, input.leaseEpoch, input.reset ?? false],
        );
        return result.rows[0]?.github_preflight_failure_count ?? null;
      },
    );
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteExpiredGithubCapabilities(
  pool: Pool,
  retentionSeconds: number,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM github_repository_capabilities WHERE (installation_id, owner, repo) IN (
      SELECT c.installation_id, c.owner, c.repo FROM github_repository_capabilities c
        WHERE c.observed_at < now() - ($1::bigint * interval '1 second')
          AND NOT EXISTS (SELECT 1 FROM agent_work_items w
            WHERE w.installation_id = c.installation_id AND w.owner = c.owner AND w.repo = c.repo)
        LIMIT $2
    )`,
    [retentionSeconds, RETENTION_DELETE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}
