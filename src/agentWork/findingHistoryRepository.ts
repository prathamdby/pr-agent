import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import { parseStoredInlineBatches } from "./publishRecordRepository.js";
import type { BotFindingThread } from "../review/run/reviewPriorFeedback.js";

export type FindingHistoryOutcome = "open" | "fixed" | "already-resolved" | "dismissed" | "skipped";

export type FindingHistoryRow = {
  readonly fingerprint: string;
  readonly lastOutcome: FindingHistoryOutcome;
  readonly dismissCount: number;
  readonly fixCount: number;
  readonly openCount: number;
  readonly lastPrNumber: number | null;
  readonly lastWorkItemId: string | null;
  readonly lastHeadSha: string | null;
  readonly lastSeenAt: Date;
  readonly firstSeenAt: Date;
};

export type FindingHistoryRepoScope = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
};

export type FindingHistoryWriteScope = FindingHistoryRepoScope & {
  readonly prNumber?: number | null;
  readonly workItemId?: string | null;
  readonly headSha?: string | null;
};

type FindingHistoryConfig = Pick<
  Config,
  "findingHistoryEnabled" | "findingHistoryDismissSuppressAfter" | "findingHistoryLookbackDays"
>;

function mapFindingHistoryRow(row: {
  fingerprint: string;
  last_outcome: FindingHistoryOutcome;
  dismiss_count: number;
  fix_count: number;
  open_count: number;
  last_pr_number: number | null;
  last_work_item_id: string | null;
  last_head_sha: string | null;
  last_seen_at: Date;
  first_seen_at: Date;
}): FindingHistoryRow {
  return {
    fingerprint: row.fingerprint,
    lastOutcome: row.last_outcome,
    dismissCount: row.dismiss_count,
    fixCount: row.fix_count,
    openCount: row.open_count,
    lastPrNumber: row.last_pr_number,
    lastWorkItemId: row.last_work_item_id,
    lastHeadSha: row.last_head_sha,
    lastSeenAt: new Date(row.last_seen_at),
    firstSeenAt: new Date(row.first_seen_at),
  };
}

export async function upsertFindingHistoryOpen(
  client: Pool | PoolClient,
  scope: FindingHistoryWriteScope,
  fingerprints: readonly string[],
): Promise<void> {
  if (fingerprints.length === 0) return;

  // One INSERT cannot carry repeated ON CONFLICT keys; first-seen wins.
  const uniqueFingerprints = [...new Set(fingerprints)];

  await client.query(
    `INSERT INTO repo_finding_history (
       installation_id, owner, repo, fingerprint, last_outcome,
       open_count, last_pr_number, last_work_item_id, last_head_sha,
       last_seen_at, first_seen_at
     )
     SELECT $1, $2, $3, fingerprint, 'open', 1, $4, $5, $6, now(), now()
       FROM unnest($7::text[]) AS fingerprints(fingerprint)
     ON CONFLICT (installation_id, owner, repo, fingerprint)
     DO UPDATE SET
       last_outcome = 'open',
       open_count = CASE
         WHEN repo_finding_history.last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id
           AND repo_finding_history.last_outcome = 'open'
         THEN repo_finding_history.open_count
         ELSE repo_finding_history.open_count + 1
       END,
       last_pr_number = EXCLUDED.last_pr_number,
       last_work_item_id = EXCLUDED.last_work_item_id,
       last_head_sha = EXCLUDED.last_head_sha,
       last_seen_at = now()`,
    [
      scope.installationId,
      scope.owner,
      scope.repo,
      scope.prNumber ?? null,
      scope.workItemId ?? null,
      scope.headSha ?? null,
      uniqueFingerprints,
    ],
  );
}

export async function recordFindingHistoryOutcome(
  client: Pool | PoolClient,
  scope: FindingHistoryWriteScope,
  fingerprint: string,
  outcome: Exclude<FindingHistoryOutcome, "open">,
): Promise<void> {
  const dismissIncrement = outcome === "dismissed" ? 1 : 0;
  const fixIncrement = outcome === "fixed" || outcome === "already-resolved" ? 1 : 0;
  // Idempotent for same work item + outcome (retries after durable GitHub ops).
  await client.query(
    `INSERT INTO repo_finding_history (
       installation_id, owner, repo, fingerprint, last_outcome,
       dismiss_count, fix_count, last_pr_number, last_work_item_id, last_head_sha,
       last_seen_at, first_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
     ON CONFLICT (installation_id, owner, repo, fingerprint)
     DO UPDATE SET
       last_outcome = EXCLUDED.last_outcome,
       dismiss_count = CASE
         WHEN repo_finding_history.last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id
           AND repo_finding_history.last_outcome = EXCLUDED.last_outcome
         THEN repo_finding_history.dismiss_count
         ELSE repo_finding_history.dismiss_count + EXCLUDED.dismiss_count
       END,
       fix_count = CASE
         WHEN repo_finding_history.last_work_item_id IS NOT DISTINCT FROM EXCLUDED.last_work_item_id
           AND repo_finding_history.last_outcome = EXCLUDED.last_outcome
         THEN repo_finding_history.fix_count
         ELSE repo_finding_history.fix_count + EXCLUDED.fix_count
       END,
       last_pr_number = EXCLUDED.last_pr_number,
       last_work_item_id = EXCLUDED.last_work_item_id,
       last_head_sha = EXCLUDED.last_head_sha,
       last_seen_at = now()`,
    [
      scope.installationId,
      scope.owner,
      scope.repo,
      fingerprint,
      outcome,
      dismissIncrement,
      fixIncrement,
      scope.prNumber ?? null,
      scope.workItemId ?? null,
      scope.headSha ?? null,
    ],
  );
}

export async function loadCrossPrSuppressionFingerprints(
  client: Pool | PoolClient,
  cfg: FindingHistoryConfig,
  scope: FindingHistoryRepoScope,
): Promise<readonly string[]> {
  if (!cfg.findingHistoryEnabled) return [];
  // Lift suppression once last_outcome is no longer dismissed.
  const result = await client.query<{ fingerprint: string }>(
    `SELECT fingerprint
       FROM repo_finding_history
      WHERE installation_id = $1
        AND owner = $2
        AND repo = $3
        AND dismiss_count >= $4
        AND last_outcome = 'dismissed'
        AND last_seen_at >= now() - ($5::text || ' days')::interval`,
    [
      scope.installationId,
      scope.owner,
      scope.repo,
      cfg.findingHistoryDismissSuppressAfter,
      String(cfg.findingHistoryLookbackDays),
    ],
  );
  return result.rows.map((row) => row.fingerprint);
}

export async function loadFindingHistoryCandidates(
  client: Pool | PoolClient,
  cfg: FindingHistoryConfig,
  scope: FindingHistoryRepoScope,
): Promise<readonly FindingHistoryRow[]> {
  if (!cfg.findingHistoryEnabled) return [];
  const result = await client.query<{
    fingerprint: string;
    last_outcome: FindingHistoryOutcome;
    dismiss_count: number;
    fix_count: number;
    open_count: number;
    last_pr_number: number | null;
    last_work_item_id: string | null;
    last_head_sha: string | null;
    last_seen_at: Date;
    first_seen_at: Date;
  }>(
    `SELECT fingerprint, last_outcome, dismiss_count, fix_count, open_count,
            last_pr_number, last_work_item_id, last_head_sha, last_seen_at, first_seen_at
       FROM repo_finding_history
      WHERE installation_id = $1
        AND owner = $2
        AND repo = $3
        AND dismiss_count > 0
        AND last_seen_at >= now() - ($4::text || ' days')::interval
      ORDER BY dismiss_count DESC, last_seen_at DESC`,
    [scope.installationId, scope.owner, scope.repo, String(cfg.findingHistoryLookbackDays)],
  );
  return result.rows.map(mapFindingHistoryRow);
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function lookupThreadFingerprint(
  client: Pool | PoolClient,
  params: {
    readonly resourceKey: string;
    readonly thread: Pick<BotFindingThread, "path" | "line">;
  },
): Promise<string | null> {
  const threadPath = normalizeRepoPath(params.thread.path);
  const result = await client.query<{ detail: Record<string, unknown> | null }>(
    `SELECT detail
       FROM publish_records
      WHERE resource_key = $1
        AND step = 'inline_review'
        AND status = 'completed'`,
    [params.resourceKey],
  );
  for (const row of result.rows) {
    for (const batch of parseStoredInlineBatches(row.detail ?? {})) {
      for (const placement of batch.placements) {
        if (
          normalizeRepoPath(placement.finding.file) === threadPath &&
          placement.resolvedLine === params.thread.line
        ) {
          return placement.canonicalFingerprint;
        }
      }
    }
  }
  return null;
}

/** Fire-and-forget open upsert that never throws into the publish hot path. */
export function safeUpsertFindingHistoryOpen(
  client: Pool | PoolClient,
  cfg: Pick<Config, "findingHistoryEnabled">,
  scope: FindingHistoryWriteScope,
  fingerprints: readonly string[],
): void {
  if (!cfg.findingHistoryEnabled || fingerprints.length === 0) return;
  void upsertFindingHistoryOpen(client, scope, fingerprints).catch((error) => {
    logWarn("finding_history_open_upsert_failed", {
      owner: scope.owner,
      repo: scope.repo,
      count: fingerprints.length,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Fire-and-forget outcome write that never throws into verification/triage hot paths. */
export function safeRecordFindingHistoryOutcome(
  client: Pool | PoolClient,
  cfg: Pick<Config, "findingHistoryEnabled">,
  scope: FindingHistoryWriteScope,
  fingerprint: string,
  outcome: Exclude<FindingHistoryOutcome, "open">,
): void {
  if (!cfg.findingHistoryEnabled) return;
  void recordFindingHistoryOutcome(client, scope, fingerprint, outcome).catch((error) => {
    logWarn("finding_history_outcome_failed", {
      owner: scope.owner,
      repo: scope.repo,
      fingerprint,
      outcome,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Fire-and-forget thread outcome write resolved from publish-record placements. */
export function safeRecordThreadFindingHistoryOutcome(
  client: Pool | PoolClient,
  cfg: Pick<Config, "findingHistoryEnabled">,
  params: {
    readonly scope: FindingHistoryWriteScope;
    readonly resourceKey: string;
    readonly thread: Pick<BotFindingThread, "path" | "line">;
    readonly outcome: Exclude<FindingHistoryOutcome, "open">;
  },
): void {
  if (!cfg.findingHistoryEnabled) return;
  void lookupThreadFingerprint(client, {
    resourceKey: params.resourceKey,
    thread: params.thread,
  })
    .then((fingerprint) => {
      if (fingerprint == null) return;
      return recordFindingHistoryOutcome(client, params.scope, fingerprint, params.outcome);
    })
    .catch((error) => {
      logWarn("finding_history_thread_outcome_failed", {
        owner: params.scope.owner,
        repo: params.scope.repo,
        outcome: params.outcome,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function safeLoadCrossPrSuppressionFingerprints(
  client: Pool | PoolClient,
  cfg: FindingHistoryConfig,
  scope: FindingHistoryRepoScope,
): Promise<readonly string[]> {
  if (!cfg.findingHistoryEnabled) return [];
  try {
    return await loadCrossPrSuppressionFingerprints(client, cfg, scope);
  } catch (error) {
    logWarn("finding_history_suppression_load_failed", {
      owner: scope.owner,
      repo: scope.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function safeLoadFindingHistoryCandidates(
  client: Pool | PoolClient,
  cfg: FindingHistoryConfig,
  scope: FindingHistoryRepoScope,
): Promise<readonly FindingHistoryRow[]> {
  if (!cfg.findingHistoryEnabled) return [];
  try {
    return await loadFindingHistoryCandidates(client, cfg, scope);
  } catch (error) {
    logWarn("finding_history_candidates_load_failed", {
      owner: scope.owner,
      repo: scope.repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function formatFindingHistoryTrustedBlock(
  rows: readonly FindingHistoryRow[],
  suppressAfter: number,
): string | undefined {
  const notable = rows.filter((row) => row.dismissCount >= suppressAfter);
  if (notable.length === 0) return undefined;

  const lines = [
    "## Cross-PR finding history (trusted context)",
    "Threshold memory only — not maintainer preference. Prefer `.pr-agent/*.mdc` policy suggestions over re-reporting unless code at the cited location materially changed.",
    "",
  ];
  for (const row of notable) {
    lines.push(
      `- fingerprint \`${row.fingerprint}\` dismissed ${row.dismissCount}×; prefer policy suggestion over re-report unless code changed`,
    );
  }
  return lines.join("\n");
}
