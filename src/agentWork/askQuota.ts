import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { inTransaction } from "../db/postgres.js";
import { AppError } from "../errors/appError.js";
import type { AgentRunnerUsageMetadata } from "../agent/providers/usageMetadata.js";
import {
  DEFAULT_ASK_ACTOR_BURST,
  DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
  DEFAULT_ASK_ACTOR_REFILL_SECONDS,
  DEFAULT_ASK_INSTALLATION_BURST,
  DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
  DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
  DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
  DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
  DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  DEFAULT_ASK_REPOSITORY_BURST,
  DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
  DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
} from "../settings/index.js";

export type AskQuotaConfig = Pick<
  Config,
  | "askActorMaxOutstanding"
  | "askRepositoryMaxOutstanding"
  | "askInstallationMaxOutstanding"
  | "askActorBurst"
  | "askRepositoryBurst"
  | "askInstallationBurst"
  | "askActorRefillSeconds"
  | "askRepositoryRefillSeconds"
  | "askInstallationRefillSeconds"
  | "askProviderBudgetTokens"
  | "askProviderBudgetWindowSeconds"
  | "askProviderReservationTokens"
>;

export function defaultAskQuotaConfig(): AskQuotaConfig {
  return {
    askActorMaxOutstanding: DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
    askRepositoryMaxOutstanding: DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
    askInstallationMaxOutstanding: DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
    askActorBurst: DEFAULT_ASK_ACTOR_BURST,
    askRepositoryBurst: DEFAULT_ASK_REPOSITORY_BURST,
    askInstallationBurst: DEFAULT_ASK_INSTALLATION_BURST,
    askActorRefillSeconds: DEFAULT_ASK_ACTOR_REFILL_SECONDS,
    askRepositoryRefillSeconds: DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
    askInstallationRefillSeconds: DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
    askProviderBudgetTokens: DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
    askProviderBudgetWindowSeconds: DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
    askProviderReservationTokens: DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  };
}

export function resolveAskQuotaConfig(config: Partial<AskQuotaConfig> | undefined): AskQuotaConfig {
  return { ...defaultAskQuotaConfig(), ...config };
}

export type AskQuotaRejectionReason =
  | "actor_outstanding"
  | "actor_rate"
  | "repository_outstanding"
  | "repository_rate"
  | "installation_outstanding"
  | "installation_rate"
  | "provider_budget";

export type AskQuotaAdmission =
  | { readonly kind: "admitted"; readonly providerReservationTokens: number }
  | { readonly kind: "throttled"; readonly reason: AskQuotaRejectionReason };

type AskQuotaScope = "actor" | "repository" | "installation";

type AskQuotaBucketRow = {
  readonly scope: AskQuotaScope;
  readonly scope_key: string;
  readonly token_balance: number;
  readonly last_refill_at: Date | string;
  readonly outstanding_count: number;
  readonly provider_tokens_used: string | number;
  readonly provider_tokens_reserved: string | number;
  readonly provider_window_started_at: Date | string;
};

type AskQuotaBucket = AskQuotaBucketRow & {
  readonly tokenBalance: number;
  readonly outstandingCount: number;
  readonly providerTokensUsed: number;
  readonly providerTokensReserved: number;
  readonly providerWindowStartedAt: Date;
};

type AskQuotaScopeParams = {
  readonly scope: AskQuotaScope;
  readonly key: string;
  readonly maxOutstanding: number;
  readonly burst: number;
  readonly refillSeconds: number;
};

const BUCKET_LOCK_ORDER: readonly AskQuotaScope[] = ["installation", "repository", "actor"];

const ADMISSION_CHECK_ORDER: readonly AskQuotaScope[] = ["actor", "repository", "installation"];

function installationScopeKey(installationId: number): string {
  return `installation:${installationId}`;
}

function repositoryScopeKey(installationId: number, owner: string, repo: string): string {
  return `repository:${installationId}:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

function actorScopeKey(installationId: number, commenterId: number): string {
  return `actor:${installationId}:${commenterId}`;
}

function scopeParams(
  config: AskQuotaConfig,
  input: {
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly commenterId: number;
  },
): readonly AskQuotaScopeParams[] {
  return [
    {
      scope: "installation",
      key: installationScopeKey(input.installationId),
      maxOutstanding: config.askInstallationMaxOutstanding,
      burst: config.askInstallationBurst,
      refillSeconds: config.askInstallationRefillSeconds,
    },
    {
      scope: "repository",
      key: repositoryScopeKey(input.installationId, input.owner, input.repo),
      maxOutstanding: config.askRepositoryMaxOutstanding,
      burst: config.askRepositoryBurst,
      refillSeconds: config.askRepositoryRefillSeconds,
    },
    {
      scope: "actor",
      key: actorScopeKey(input.installationId, input.commenterId),
      maxOutstanding: config.askActorMaxOutstanding,
      burst: config.askActorBurst,
      refillSeconds: config.askActorRefillSeconds,
    },
  ];
}

function numberValue(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function lockAndRefillBucket(
  client: PoolClient,
  params: AskQuotaScopeParams,
  config: AskQuotaConfig,
): Promise<AskQuotaBucket> {
  await client.query(
    `INSERT INTO ask_quota_buckets (
       scope, scope_key, token_balance, last_refill_at,
       outstanding_count, provider_tokens_used, provider_tokens_reserved,
       provider_window_started_at, updated_at
     ) VALUES ($1, $2, $3, now(), 0, 0, 0, now(), now())
     ON CONFLICT (scope, scope_key) DO NOTHING`,
    [params.scope, params.key, params.burst],
  );

  const result = await client.query<AskQuotaBucketRow>(
    `SELECT scope, scope_key, token_balance, last_refill_at,
            outstanding_count, provider_tokens_used, provider_tokens_reserved,
            provider_window_started_at
       FROM ask_quota_buckets
      WHERE scope = $1 AND scope_key = $2
      FOR UPDATE`,
    [params.scope, params.key],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      code: "agent_work.ask_quota_bucket_missing",
      message: `Ask quota bucket ${params.scope}/${params.key} was not created`,
      context: { scope: params.scope },
    });
  }

  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - new Date(row.last_refill_at).getTime()) / 1000);
  const tokenBalance = Math.min(
    params.burst,
    Math.max(0, row.token_balance) + elapsedSeconds / params.refillSeconds,
  );
  let providerTokensUsed = numberValue(row.provider_tokens_used);
  let providerWindowStartedAt = new Date(row.provider_window_started_at);
  const providerTokensReserved = numberValue(row.provider_tokens_reserved);
  // Only settled spend belongs to the expired window, so only
  // provider_tokens_used resets. A reservation that straddles the boundary
  // stays in provider_tokens_reserved and keeps counting against the new
  // window. Settlement later converts it to used in whichever window is current,
  // so it is charged to one window and never twice. Folding it into used here
  // would double-count it at settlement.
  if (
    params.scope === "installation" &&
    config.askProviderBudgetTokens > 0 &&
    now - providerWindowStartedAt.getTime() >= config.askProviderBudgetWindowSeconds * 1000
  ) {
    providerTokensUsed = 0;
    providerWindowStartedAt = new Date(now);
  }

  await client.query(
    `UPDATE ask_quota_buckets
        SET token_balance = $3,
            last_refill_at = clock_timestamp(),
            provider_tokens_used = $4,
            provider_window_started_at = $5,
            updated_at = clock_timestamp()
      WHERE scope = $1 AND scope_key = $2`,
    [params.scope, params.key, tokenBalance, providerTokensUsed, providerWindowStartedAt],
  );

  return {
    ...row,
    tokenBalance,
    outstandingCount: row.outstanding_count,
    providerTokensUsed,
    providerTokensReserved,
    providerWindowStartedAt,
  };
}

function bucketByScope(buckets: readonly AskQuotaBucket[], scope: AskQuotaScope): AskQuotaBucket {
  const bucket = buckets.find((candidate) => candidate.scope === scope);
  if (!bucket) {
    throw new AppError({
      code: "agent_work.ask_quota_scope_missing",
      message: `Ask quota scope ${scope} was not loaded`,
      context: { scope },
    });
  }
  return bucket;
}

/**
 * Reserve all ask capacity before the work item exists. The caller must insert
 * the matching work item in the same transaction. The deferred FK on the
 * reservation table keeps that ordering safe.
 */
export async function admitAsk(
  client: PoolClient,
  params: {
    readonly workItemId: string;
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly commenterId: number;
  },
  config: AskQuotaConfig,
): Promise<AskQuotaAdmission> {
  const scopes = scopeParams(config, params);
  const buckets: AskQuotaBucket[] = [];
  for (const scope of BUCKET_LOCK_ORDER) {
    const descriptor = scopes.find((candidate) => candidate.scope === scope);
    if (!descriptor) throw new Error(`missing ask quota descriptor ${scope}`);
    buckets.push(await lockAndRefillBucket(client, descriptor, config));
  }

  for (const scope of ADMISSION_CHECK_ORDER) {
    const descriptor = scopes.find((candidate) => candidate.scope === scope);
    if (!descriptor) throw new Error(`missing ask quota descriptor ${scope}`);
    const bucket = bucketByScope(buckets, scope);
    if (bucket.outstandingCount >= descriptor.maxOutstanding) {
      return {
        kind: "throttled",
        reason: `${scope}_outstanding` as AskQuotaRejectionReason,
      };
    }
    if (bucket.tokenBalance < 1) {
      return {
        kind: "throttled",
        reason: `${scope}_rate` as AskQuotaRejectionReason,
      };
    }
  }

  const installation = bucketByScope(buckets, "installation");
  const providerReservationTokens =
    config.askProviderBudgetTokens > 0 ? config.askProviderReservationTokens : 0;
  if (
    providerReservationTokens > 0 &&
    installation.providerTokensUsed +
      installation.providerTokensReserved +
      providerReservationTokens >
      config.askProviderBudgetTokens
  ) {
    return { kind: "throttled", reason: "provider_budget" };
  }

  for (const descriptor of scopes) {
    const bucket = bucketByScope(buckets, descriptor.scope);
    await client.query(
      `UPDATE ask_quota_buckets
          SET token_balance = $3,
              outstanding_count = outstanding_count + 1,
              updated_at = clock_timestamp()
        WHERE scope = $1 AND scope_key = $2`,
      [descriptor.scope, descriptor.key, bucket.tokenBalance - 1],
    );
  }

  if (providerReservationTokens > 0) {
    await client.query(
      `UPDATE ask_quota_buckets
          SET provider_tokens_reserved = provider_tokens_reserved + $2,
              updated_at = clock_timestamp()
        WHERE scope = 'installation' AND scope_key = $1`,
      [installationScopeKey(params.installationId), providerReservationTokens],
    );
  }

  await client.query(
    `INSERT INTO ask_quota_reservations (
       work_item_id, actor_scope_key, repository_scope_key,
       installation_scope_key, reserved_provider_tokens
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      params.workItemId,
      actorScopeKey(params.installationId, params.commenterId),
      repositoryScopeKey(params.installationId, params.owner, params.repo),
      installationScopeKey(params.installationId),
      providerReservationTokens,
    ],
  );

  return { kind: "admitted", providerReservationTokens };
}

async function decrementOutstanding(
  client: PoolClient,
  scope: AskQuotaScope,
  key: string,
  providerTokensReserved = 0,
): Promise<void> {
  const result = await client.query(
    `UPDATE ask_quota_buckets
        SET outstanding_count = GREATEST(0, outstanding_count - 1),
            provider_tokens_reserved = GREATEST(0, provider_tokens_reserved - $3),
            updated_at = clock_timestamp()
      WHERE scope = $1 AND scope_key = $2`,
    [scope, key, providerTokensReserved],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError({
      code: "agent_work.ask_quota_bucket_missing_on_release",
      message: `Ask quota bucket ${scope}/${key} was missing during release`,
      context: { scope },
    });
  }
}

/** Release a reservation that lost an insert race before a work item existed. */
export async function releaseAskQuotaReservation(
  client: PoolClient,
  workItemId: string,
): Promise<void> {
  const result = await client.query<{
    actor_scope_key: string;
    repository_scope_key: string;
    installation_scope_key: string;
    reserved_provider_tokens: string | number;
    released_at: Date | null;
  }>(
    `SELECT actor_scope_key, repository_scope_key, installation_scope_key,
            reserved_provider_tokens, released_at
       FROM ask_quota_reservations
      WHERE work_item_id = $1
      FOR UPDATE`,
    [workItemId],
  );
  const reservation = result.rows[0];
  if (!reservation || reservation.released_at != null) return;

  await client.query(
    `UPDATE ask_quota_reservations
        SET released_at = clock_timestamp()
      WHERE work_item_id = $1 AND released_at IS NULL`,
    [workItemId],
  );
  await decrementOutstanding(
    client,
    "installation",
    reservation.installation_scope_key,
    numberValue(reservation.reserved_provider_tokens),
  );
  await decrementOutstanding(client, "repository", reservation.repository_scope_key);
  await decrementOutstanding(client, "actor", reservation.actor_scope_key);
}

/**
 * Record exact provider usage when Pi exposes it. Unknown usage stays reserved
 * and is charged at the reservation maximum by the terminal-state trigger.
 */
export async function recordAskProviderUsage(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly usage?: AgentRunnerUsageMetadata;
  },
): Promise<void> {
  const totalTokens = params.usage?.totalTokens;
  if (totalTokens == null || !Number.isFinite(totalTokens) || totalTokens < 0) return;
  const actualTokens = Math.floor(totalTokens);

  await inTransaction(pool, async (client) => {
    const result = await client.query<{
      installation_scope_key: string;
      reserved_provider_tokens: string | number;
      provider_usage_known: boolean;
      released_at: Date | null;
    }>(
      `SELECT installation_scope_key, reserved_provider_tokens,
              provider_usage_known, released_at
         FROM ask_quota_reservations
        WHERE work_item_id = $1
        FOR UPDATE`,
      [params.workItemId],
    );
    const reservation = result.rows[0];
    if (!reservation || reservation.released_at != null || reservation.provider_usage_known) {
      return;
    }

    const reserved = numberValue(reservation.reserved_provider_tokens);
    await client.query(
      `UPDATE ask_quota_reservations
          SET provider_usage_known = true,
              provider_tokens_used = $2,
              reserved_provider_tokens = 0,
              updated_at = clock_timestamp()
        WHERE work_item_id = $1`,
      [params.workItemId, actualTokens],
    );
    const bucket = await client.query(
      `UPDATE ask_quota_buckets
          SET provider_tokens_reserved = GREATEST(0, provider_tokens_reserved - $2),
              provider_tokens_used = provider_tokens_used + $3,
              updated_at = clock_timestamp()
        WHERE scope = 'installation' AND scope_key = $1
        RETURNING scope_key`,
      [reservation.installation_scope_key, reserved, actualTokens],
    );
    if ((bucket.rowCount ?? 0) === 0) {
      throw new AppError({
        code: "agent_work.ask_quota_provider_bucket_missing",
        message: "Ask provider quota bucket was missing while recording usage",
      });
    }
  });
}

export function askQuotaScopeKeys(params: {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly commenterId: number;
}): readonly string[] {
  return [
    actorScopeKey(params.installationId, params.commenterId),
    repositoryScopeKey(params.installationId, params.owner, params.repo),
    installationScopeKey(params.installationId),
  ];
}

/** Delete inactive bucket rows so long-lived installations do not grow without bound. */
export async function deleteExpiredAskQuotaState(
  pool: Pool,
  retentionSeconds: number,
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM ask_quota_buckets
        WHERE (scope, scope_key) IN (
          SELECT b.scope, b.scope_key
            FROM ask_quota_buckets b
           WHERE b.updated_at < now() - ($1::bigint * interval '1 second')
             AND b.outstanding_count = 0
             AND b.provider_tokens_reserved = 0
             AND NOT EXISTS (
               SELECT 1
                 FROM ask_quota_reservations r
                WHERE r.released_at IS NULL
                  AND (
                    (b.scope = 'actor' AND r.actor_scope_key = b.scope_key)
                    OR (b.scope = 'repository' AND r.repository_scope_key = b.scope_key)
                    OR (b.scope = 'installation' AND r.installation_scope_key = b.scope_key)
                  )
             )
           LIMIT $2::int
        )`,
      [retentionSeconds, batchSize],
    );
    const batch = result.rowCount ?? 0;
    deleted += batch;
    if (batch < batchSize) return deleted;
  }
}
