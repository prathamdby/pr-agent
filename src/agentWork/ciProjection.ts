import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { pgBossDb } from "../db/postgres.js";
import { AppError } from "../errors/appError.js";
import {
  ciSummaryFromFacts,
  headCiFactsAreComplete,
  waitingCiSummary,
  type RenderableHeadCi,
} from "../review/ci/ciFacts.js";
import { AUTOMATED_PR_ACTIONS, CI_PROJECTION_QUEUE, DEFERRED_HEAD_SHA } from "../settings/index.js";
import { headCiNeedsSeed, loadPrHeadCiState, type PrHeadCiStateRow } from "./prHeadCiState.js";
import { installationGroupId, type CiProjectionJobData, type JobCorrelation } from "./types.js";
import { loadGithubCiSourceAvailability } from "./githubCapabilityRepository.js";

export async function loadRenderableHeadCi(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
  installationId?: number,
): Promise<RenderableHeadCi> {
  const sourceAvailability =
    installationId == null
      ? undefined
      : await loadGithubCiSourceAvailability(pool, { installationId, owner, repo, headSha });
  const row = await loadPrHeadCiState(pool, owner, repo, headSha);
  if (row == null) return waitingCiSummary(0);
  if (headCiNeedsSeed(row) && sourceAvailability == null) return waitingCiSummary(row.version);
  return ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
    sourceAvailability,
  });
}

function isHeadCiSeedPullRequestAction(action: string): boolean {
  return action !== "closed" && AUTOMATED_PR_ACTIONS.has(action);
}

/** True when this pull_request action and SHA may request a first head seed. */
export function isHeadCiSeedPullRequest(action: string, headSha: string): boolean {
  return isHeadCiSeedPullRequestAction(action) && headSha !== DEFERRED_HEAD_SHA;
}

/** True when this pull_request delivery should schedule the first head seed. */
export function shouldSeedHeadCiFromPullRequest(
  action: string,
  headSha: string,
  row: Pick<PrHeadCiStateRow, "seededAt"> | null,
): boolean {
  return isHeadCiSeedPullRequest(action, headSha) && headCiNeedsSeed(row);
}

/** True when a claim-time writer should enqueue after stamping the cell. */
export function ciProjectionDue(
  row: Pick<PrHeadCiStateRow, "seededAt" | "version"> | null,
  renderedVersion: number,
): boolean {
  if (headCiNeedsSeed(row)) return true;
  return row != null && row.version > renderedVersion;
}

const CI_PROJECTION_DEBOUNCE_SECONDS = 5;

type CiProjectionPayload = CiProjectionJobData & {
  readonly correlations?: readonly JobCorrelation[];
};

function ciProjectionCorrelations(data: CiProjectionPayload): JobCorrelation[] {
  const correlations = new Map<string, JobCorrelation>();
  for (const identity of [...(data.correlations ?? []), data]) {
    const correlation: JobCorrelation = {
      ...(identity.webhookEventId ? { webhookEventId: identity.webhookEventId } : {}),
      ...(identity.delivery ? { delivery: identity.delivery } : {}),
    };
    if (Object.keys(correlation).length > 0) {
      correlations.set(JSON.stringify(correlation), correlation);
    }
  }
  return [...correlations.values()];
}

async function mergeCiProjectionCorrelations(
  client: PoolClient,
  data: CiProjectionJobData,
  singletonKey: string,
  correlations: readonly JobCorrelation[],
): Promise<void> {
  // pg-boss tries the current slot, then the next. Its throttle index includes
  // active and terminal rows; append against the locked row, not a stale read.
  const { rows } = await client.query<{ id: string }>(
    `UPDATE pgboss.job
        SET data = jsonb_set(data, '{correlations}', (
          SELECT jsonb_agg(DISTINCT correlation)
            FROM jsonb_array_elements(
              COALESCE(data->'correlations', '[]'::jsonb)
              || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'webhookEventId', NULLIF(data->>'webhookEventId', ''),
                'delivery', NULLIF(data->>'delivery', '')
              )))
              || $8::jsonb
            ) AS identities(correlation)
           WHERE correlation <> '{}'::jsonb
        ))
      WHERE name = $1
        AND singleton_key = $2
        AND singleton_on = 'epoch'::timestamp + '1s'::interval
          * ($3::float8 * floor((date_part('epoch', now()) + $3::float8) / $3::float8))
        AND state <> 'cancelled'
        AND data->>'owner' = $4
        AND data->>'repo' = $5
        AND data->>'headSha' = $6
        AND data->>'installationId' = $7::text
      RETURNING id`,
    [
      CI_PROJECTION_QUEUE,
      singletonKey,
      CI_PROJECTION_DEBOUNCE_SECONDS,
      data.owner,
      data.repo,
      data.headSha,
      data.installationId,
      JSON.stringify(correlations),
    ],
  );
  if (rows.length !== 1) {
    throw new AppError({
      domain: "agent_work",
      kind: "ci_projection_correlation_missing",
      message: "CI projection correlation target is missing",
      context: {
        queue: CI_PROJECTION_QUEUE,
        owner: data.owner,
        repo: data.repo,
        headSha: data.headSha,
      },
    });
  }
}

/**
 * - `intake`: debounced inside the caller's transaction; a later write joins the
 *   next 5s slot and keeps its delivery identity in the job's `correlations`.
 * - `debounced`: the same slot without a transaction, for the projector and
 *   writers that hold none. It carries the identities the head already has.
 * - `after`: one job deferred until the rate-limit circuit closes.
 * - `when_due`: `debounced` only when the head still needs a seed or its row
 *   moved past the version the writer just rendered.
 */
export type HeadCiProjectionSchedule =
  | { readonly kind: "intake"; readonly client: PoolClient }
  | { readonly kind: "debounced" }
  | { readonly kind: "after"; readonly seconds: number }
  | { readonly kind: "when_due"; readonly pool: Pool; readonly renderedVersion: number };

export type HeadCiProjectionResult = "enqueued" | "already_present" | "skipped";

/** The one way to ask for a `ci-projection` job for a head. */
export async function requestHeadCiProjection(
  boss: PgBoss | undefined,
  head: Omit<CiProjectionJobData, "kind">,
  schedule: HeadCiProjectionSchedule,
): Promise<HeadCiProjectionResult> {
  if (boss == null) return "skipped";
  if (schedule.kind === "when_due") {
    if (head.installationId <= 0) return "skipped";
    const row = await loadPrHeadCiState(schedule.pool, head.owner, head.repo, head.headSha);
    if (!ciProjectionDue(row, schedule.renderedVersion)) return "skipped";
  }
  const data: CiProjectionJobData = { kind: "ci_projection", ...head };
  const singletonKey = `${data.owner}/${data.repo}:${data.headSha}`;
  const group = { id: installationGroupId(data.installationId) };

  if (schedule.kind === "after") {
    const startAfter = Math.max(1, schedule.seconds);
    const jobId = await boss.send(CI_PROJECTION_QUEUE, data, {
      startAfter,
      singletonKey: `${singletonKey}:deferred`,
      singletonSeconds: startAfter,
      priority: 40,
      group,
    });
    return jobId == null ? "already_present" : "enqueued";
  }

  if (schedule.kind === "intake") {
    const correlations = ciProjectionCorrelations(data);
    const payload = correlations.length > 0 ? { ...data, correlations } : data;
    const jobId = await boss.sendDebounced(
      CI_PROJECTION_QUEUE,
      payload,
      { db: pgBossDb(schedule.client), priority: 40, group },
      CI_PROJECTION_DEBOUNCE_SECONDS,
      singletonKey,
    );
    if (jobId != null) return "enqueued";
    if (correlations.length > 0) {
      await mergeCiProjectionCorrelations(schedule.client, data, singletonKey, correlations);
    }
    return "already_present";
  }

  const jobId = await boss.sendDebounced(
    CI_PROJECTION_QUEUE,
    data,
    { priority: 40, group },
    CI_PROJECTION_DEBOUNCE_SECONDS,
    singletonKey,
  );
  return jobId == null ? "already_present" : "enqueued";
}
