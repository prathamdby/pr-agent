import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { AppError } from "../errors/appError.ts";
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
} from "../settings/index.ts";
import { immediate, readRow, readRows } from "./db.ts";

export type AskQuotaConfig = {
  readonly installationMaxOutstanding: number;
  readonly installationBurst: number;
  readonly installationRefillSeconds: number;
  readonly repositoryMaxOutstanding: number;
  readonly repositoryBurst: number;
  readonly repositoryRefillSeconds: number;
  readonly actorMaxOutstanding: number;
  readonly actorBurst: number;
  readonly actorRefillSeconds: number;
  readonly providerBudgetTokens: number;
  readonly providerBudgetWindowSeconds: number;
  readonly providerReservationTokens: number;
};

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

export function defaultAskQuotaConfig() {
  return ((pinnedReturn: AskQuotaConfig) => pinnedReturn)({
    actorMaxOutstanding: DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
    repositoryMaxOutstanding: DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
    installationMaxOutstanding: DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
    actorBurst: DEFAULT_ASK_ACTOR_BURST,
    repositoryBurst: DEFAULT_ASK_REPOSITORY_BURST,
    installationBurst: DEFAULT_ASK_INSTALLATION_BURST,
    actorRefillSeconds: DEFAULT_ASK_ACTOR_REFILL_SECONDS,
    repositoryRefillSeconds: DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
    installationRefillSeconds: DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
    providerBudgetTokens: DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
    providerBudgetWindowSeconds: DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
    providerReservationTokens: DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  });
}

export function resolveAskQuotaConfig(config: Partial<AskQuotaConfig> | undefined) {
  return ((pinnedReturn: AskQuotaConfig) => pinnedReturn)({
    ...defaultAskQuotaConfig(),
    ...config,
  });
}

const ASK_QUOTA_SCOPES = ["actor", "repository", "installation"] as const;
type AskQuotaScope = (typeof ASK_QUOTA_SCOPES)[number];

const askQuotaBucketRowSchema = v.object({
  scope: v.picklist(ASK_QUOTA_SCOPES),
  scope_key: v.string(),
  token_balance: v.number(),
  last_refill_at: v.number(),
  outstanding_count: v.number(),
  provider_tokens_used: v.number(),
  provider_tokens_reserved: v.number(),
  provider_window_started_at: v.number(),
});

const reservationLockSchema = v.object({
  actor_scope_key: v.string(),
  repository_scope_key: v.string(),
  installation_scope_key: v.string(),
  reserved_provider_tokens: v.number(),
  provider_usage_known: v.number(),
  released_at: v.nullable(v.number()),
  unknown_usage_charged: v.number(),
  unknown_usage_window_started_at: v.nullable(v.number()),
});

const providerTokensUsedSchema = v.object({ provider_tokens_used: v.optional(v.number()) });
const providerWindowSchema = v.object({
  provider_window_started_at: v.optional(v.number()),
});

type AskQuotaScopeParams = {
  readonly scope: AskQuotaScope;
  readonly key: string;
  readonly maxOutstanding: number;
  readonly burst: number;
  readonly refillSeconds: number;
};

const BUCKET_LOCK_ORDER: readonly AskQuotaScope[] = ["installation", "repository", "actor"];
const ADMISSION_CHECK_ORDER: readonly AskQuotaScope[] = ["actor", "repository", "installation"];

export function installationScopeKey(installationId: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`installation:${installationId}`);
}

export function repositoryScopeKey(installationId: number, owner: string, repo: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `repository:${installationId}:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`,
  );
}

export function actorScopeKey(installationId: number, commenterId: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`actor:${installationId}:${commenterId}`);
}

function scopeParams(
  config: AskQuotaConfig,
  input: {
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly commenterId: number;
  },
) {
  return ((pinnedReturn: readonly AskQuotaScopeParams[]) => pinnedReturn)([
    {
      scope: "installation",
      key: installationScopeKey(input.installationId),
      maxOutstanding: config.installationMaxOutstanding,
      burst: config.installationBurst,
      refillSeconds: config.installationRefillSeconds,
    },
    {
      scope: "repository",
      key: repositoryScopeKey(input.installationId, input.owner, input.repo),
      maxOutstanding: config.repositoryMaxOutstanding,
      burst: config.repositoryBurst,
      refillSeconds: config.repositoryRefillSeconds,
    },
    {
      scope: "actor",
      key: actorScopeKey(input.installationId, input.commenterId),
      maxOutstanding: config.actorMaxOutstanding,
      burst: config.actorBurst,
      refillSeconds: config.actorRefillSeconds,
    },
  ]);
}

function numberValue(value: number | string | null | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return ((pinnedReturn: number) => pinnedReturn)(
    Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
  );
}

function lockAndRefillBucket(
  db: DatabaseSync,
  params: AskQuotaScopeParams,
  config: AskQuotaConfig,
  now: number,
) {
  db.prepare(
    `INSERT INTO ask_quota_buckets (
       scope, scope_key, token_balance, last_refill_at,
       outstanding_count, provider_tokens_used, provider_tokens_reserved,
       provider_window_started_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
     ON CONFLICT (scope, scope_key) DO NOTHING`,
  ).run(params.scope, params.key, params.burst, now, now, now);

  const row = readRow(
    db
      .prepare(
        `SELECT scope, scope_key, token_balance, last_refill_at,
              outstanding_count, provider_tokens_used, provider_tokens_reserved,
              provider_window_started_at
         FROM ask_quota_buckets
        WHERE scope = ? AND scope_key = ?`,
      )
      .get(params.scope, params.key),
    askQuotaBucketRowSchema,
  );
  if (!row) {
    throw new AppError({
      domain: "agent_work",
      kind: "ask_quota_bucket_missing",
      message: `Ask quota bucket ${params.scope}/${params.key} was not created`,
      context: { scope: params.scope },
    });
  }

  const elapsedSeconds = Math.max(0, (now - row.last_refill_at) / 1000);
  const tokenBalance = Math.min(
    params.burst,
    Math.max(0, row.token_balance) + elapsedSeconds / params.refillSeconds,
  );
  let providerTokensUsed = numberValue(row.provider_tokens_used);
  let providerWindowStartedAt = row.provider_window_started_at;
  if (
    params.scope === "installation" &&
    config.providerBudgetTokens > 0 &&
    now - providerWindowStartedAt >= config.providerBudgetWindowSeconds * 1000
  ) {
    providerTokensUsed = 0;
    providerWindowStartedAt = now;
  }

  db.prepare(
    `UPDATE ask_quota_buckets
        SET token_balance = ?, last_refill_at = ?,
            provider_tokens_used = ?, provider_window_started_at = ?, updated_at = ?
      WHERE scope = ? AND scope_key = ?`,
  ).run(
    tokenBalance,
    now,
    providerTokensUsed,
    providerWindowStartedAt,
    now,
    params.scope,
    params.key,
  );

  return ((pinnedReturn: {
    readonly scope: AskQuotaScope;
    readonly tokenBalance: number;
    readonly outstandingCount: number;
    readonly providerTokensUsed: number;
    readonly providerTokensReserved: number;
  }) => pinnedReturn)({
    scope: params.scope,
    tokenBalance,
    outstandingCount: row.outstanding_count,
    providerTokensUsed,
    providerTokensReserved: numberValue(row.provider_tokens_reserved),
  });
}

type RefilledBucket = ReturnType<typeof lockAndRefillBucket>;

function bucketByScope(buckets: readonly RefilledBucket[], scope: AskQuotaScope) {
  const bucket = buckets.find((candidate) => candidate.scope === scope);
  if (!bucket) {
    throw new AppError({
      domain: "agent_work",
      kind: "ask_quota_scope_missing",
      message: `Ask quota scope ${scope} was not loaded`,
      context: { scope },
    });
  }
  return ((pinnedReturn: RefilledBucket) => pinnedReturn)(bucket);
}

export type AskQuotaReservationParams = {
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly commenterId: number;
  readonly triggerCommentId?: number;
  readonly triggerScopeKey?: string;
};

export function reserveAskQuota(
  db: DatabaseSync,
  params: AskQuotaReservationParams,
  config: AskQuotaConfig,
  now = Date.now(),
) {
  return immediate(db, () => reserveAskQuotaTx(db, params, config, now));
}

export function reserveAskQuotaTx(
  db: DatabaseSync,
  params: AskQuotaReservationParams,
  config: AskQuotaConfig,
  now = Date.now(),
) {
  const scopes = scopeParams(config, params);
  const buckets: RefilledBucket[] = [];
  for (const scope of BUCKET_LOCK_ORDER) {
    const descriptor = scopes.find((candidate) => candidate.scope === scope);
    if (!descriptor) throw new Error(`missing ask quota descriptor ${scope}`);
    buckets.push(lockAndRefillBucket(db, descriptor, config, now));
  }

  for (const scope of ADMISSION_CHECK_ORDER) {
    const descriptor = scopes.find((candidate) => candidate.scope === scope);
    if (!descriptor) throw new Error(`missing ask quota descriptor ${scope}`);
    const bucket = bucketByScope(buckets, scope);
    if (bucket.outstandingCount >= descriptor.maxOutstanding) {
      return {
        kind: "throttled" as const,
        reason: `${scope}_outstanding` as const,
      };
    }
    if (bucket.tokenBalance < 1) {
      return { kind: "throttled" as const, reason: `${scope}_rate` as const };
    }
  }

  const installation = bucketByScope(buckets, "installation");
  const providerReservationTokens =
    config.providerBudgetTokens > 0 ? config.providerReservationTokens : 0;
  if (
    providerReservationTokens > 0 &&
    installation.providerTokensUsed +
      installation.providerTokensReserved +
      providerReservationTokens >
      config.providerBudgetTokens
  ) {
    return { kind: "throttled" as const, reason: "provider_budget" as const };
  }

  for (const descriptor of scopes) {
    const bucket = bucketByScope(buckets, descriptor.scope);
    db.prepare(
      `UPDATE ask_quota_buckets
            SET token_balance = ?, outstanding_count = outstanding_count + 1, updated_at = ?
          WHERE scope = ? AND scope_key = ?`,
    ).run(bucket.tokenBalance - 1, now, descriptor.scope, descriptor.key);
  }

  if (providerReservationTokens > 0) {
    db.prepare(
      `UPDATE ask_quota_buckets
            SET provider_tokens_reserved = provider_tokens_reserved + ?, updated_at = ?
          WHERE scope = 'installation' AND scope_key = ?`,
    ).run(providerReservationTokens, now, installationScopeKey(params.installationId));
  }

  db.prepare(
    `INSERT INTO ask_quota_reservations (
         work_item_id, actor_scope_key, repository_scope_key,
         installation_scope_key, installation_id, repo_key, trigger_comment_id,
         reserved_provider_tokens, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.workItemId,
    actorScopeKey(params.installationId, params.commenterId),
    repositoryScopeKey(params.installationId, params.owner, params.repo),
    installationScopeKey(params.installationId),
    params.installationId,
    params.triggerScopeKey ?? `${params.owner}/${params.repo}`,
    params.triggerCommentId ?? null,
    providerReservationTokens,
    now,
    now,
  );

  return { kind: "admitted" as const, providerReservationTokens };
}

function reservationByWorkId(db: DatabaseSync, workItemId: string) {
  return readRow(
    db
      .prepare(
        `SELECT actor_scope_key, repository_scope_key, installation_scope_key,
              reserved_provider_tokens, provider_usage_known, released_at,
              unknown_usage_charged, unknown_usage_window_started_at
         FROM ask_quota_reservations
        WHERE work_item_id = ?`,
      )
      .get(workItemId),
    reservationLockSchema,
  );
}

export function releaseAskQuotaReservationTx(
  db: DatabaseSync,
  workItemId: string,
  now = Date.now(),
) {
  {
    const reservation = reservationByWorkId(db, workItemId);
    if (!reservation || reservation.released_at != null) return;

    const providerCharge =
      reservation.provider_usage_known === 0
        ? numberValue(reservation.reserved_provider_tokens)
        : 0;

    let chargedWindow: number | null = null;
    if (providerCharge > 0) {
      const bucket = readRow(
        db
          .prepare(
            `SELECT provider_window_started_at FROM ask_quota_buckets
            WHERE scope = 'installation' AND scope_key = ?`,
          )
          .get(reservation.installation_scope_key),
        providerWindowSchema,
      );
      chargedWindow = bucket?.provider_window_started_at ?? null;
    }

    db.prepare(
      `UPDATE ask_quota_reservations
          SET released_at = ?, reserved_provider_tokens = 0,
              unknown_usage_charged = ?, unknown_usage_window_started_at = ?, updated_at = ?
        WHERE work_item_id = ?`,
    ).run(now, providerCharge, chargedWindow, now, workItemId);

    db.prepare(
      `UPDATE ask_quota_buckets
          SET outstanding_count = MAX(0, outstanding_count - 1),
              provider_tokens_reserved = MAX(0, provider_tokens_reserved - ?),
              provider_tokens_used = provider_tokens_used + ?, updated_at = ?
        WHERE scope = 'installation' AND scope_key = ?`,
    ).run(
      numberValue(reservation.reserved_provider_tokens),
      providerCharge,
      now,
      reservation.installation_scope_key,
    );
    db.prepare(
      `UPDATE ask_quota_buckets
          SET outstanding_count = MAX(0, outstanding_count - 1), updated_at = ?
        WHERE scope = 'repository' AND scope_key = ?`,
    ).run(now, reservation.repository_scope_key);
    db.prepare(
      `UPDATE ask_quota_buckets
          SET outstanding_count = MAX(0, outstanding_count - 1), updated_at = ?
        WHERE scope = 'actor' AND scope_key = ?`,
    ).run(now, reservation.actor_scope_key);
  }
}

export function releaseAskQuotaReservation(db: DatabaseSync, workItemId: string, now = Date.now()) {
  immediate(db, () => releaseAskQuotaReservationTx(db, workItemId, now));
}

export function createAskExecutionId() {
  return ((pinnedReturn: string) => pinnedReturn)(randomUUID());
}

function sameProviderWindow(left: number | null | undefined, right: number | null | undefined) {
  if (left == null || right == null) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(left === right);
}

type BucketApplication =
  | { readonly kind: "adjust"; readonly reservedRelease: number; readonly usedDelta: number }
  | { readonly kind: "receipt_only" };

function bucketApplicationForReceipt(input: {
  readonly reserved: number;
  readonly unknownCharged: number;
  readonly alreadyKnown: boolean;
  readonly released: boolean;
  readonly sameUnknownWindow: boolean;
  readonly actualTokens: number;
}) {
  if (input.released && input.unknownCharged > 0 && !input.sameUnknownWindow) {
    return ((pinnedReturn: BucketApplication) => pinnedReturn)({ kind: "receipt_only" });
  }
  if (input.alreadyKnown) {
    return ((pinnedReturn: BucketApplication) => pinnedReturn)({
      kind: "adjust",
      reservedRelease: 0,
      usedDelta: input.actualTokens,
    });
  }
  if (!input.released) {
    return ((pinnedReturn: BucketApplication) => pinnedReturn)({
      kind: "adjust",
      reservedRelease: input.reserved,
      usedDelta: input.actualTokens,
    });
  }
  return ((pinnedReturn: BucketApplication) => pinnedReturn)({
    kind: "adjust",
    reservedRelease: 0,
    usedDelta: input.actualTokens - input.unknownCharged,
  });
}

export function recordAskProviderUsage(
  db: DatabaseSync,
  params: {
    readonly workItemId: string;
    readonly executionId: string;
    readonly totalTokens?: number;
  },
  now = Date.now(),
) {
  const totalTokens = params.totalTokens;
  if (totalTokens == null || !Number.isFinite(totalTokens) || totalTokens < 0) return;
  if (params.executionId.length === 0) {
    throw new AppError({
      domain: "agent_work",
      kind: "ask_quota_execution_id_missing",
      message: "Ask quota usage recording requires an execution id",
      context: { workItemId: params.workItemId },
    });
  }
  const actualTokens = Math.floor(totalTokens);

  immediate(db, () => {
    const reservation = reservationByWorkId(db, params.workItemId);
    if (!reservation) return;

    const prior = readRow(
      db
        .prepare(
          `SELECT provider_tokens_used FROM ask_quota_execution_receipts
          WHERE work_item_id = ? AND execution_id = ?`,
        )
        .get(params.workItemId, params.executionId),
      providerTokensUsedSchema,
    );
    if (prior) {
      if (numberValue(prior.provider_tokens_used) !== actualTokens) {
        throw new AppError({
          domain: "agent_work",
          kind: "ask_quota_execution_conflict",
          message: "Ask quota execution received a conflicting final usage report",
          context: { workItemId: params.workItemId },
        });
      }
      return;
    }

    const bucket = readRow(
      db
        .prepare(
          `SELECT provider_window_started_at FROM ask_quota_buckets
          WHERE scope = 'installation' AND scope_key = ?`,
        )
        .get(reservation.installation_scope_key),
      providerWindowSchema,
    );
    if (!bucket) {
      throw new AppError({
        domain: "agent_work",
        kind: "ask_quota_provider_bucket_missing",
        message: "Ask provider quota bucket was missing while recording usage",
      });
    }

    db.prepare(
      `INSERT INTO ask_quota_execution_receipts (
         work_item_id, execution_id, provider_tokens_used, created_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(params.workItemId, params.executionId, actualTokens, now);

    const application = bucketApplicationForReceipt({
      reserved: numberValue(reservation.reserved_provider_tokens),
      unknownCharged: numberValue(reservation.unknown_usage_charged),
      alreadyKnown: reservation.provider_usage_known !== 0,
      released: reservation.released_at != null,
      sameUnknownWindow: sameProviderWindow(
        reservation.unknown_usage_window_started_at,
        bucket.provider_window_started_at,
      ),
      actualTokens,
    });

    switch (application.kind) {
      case "receipt_only":
        db.prepare(
          `UPDATE ask_quota_reservations
              SET provider_usage_known = 1,
                  provider_tokens_used = provider_tokens_used + ?, updated_at = ?
            WHERE work_item_id = ?`,
        ).run(actualTokens, now, params.workItemId);
        return;
      case "adjust":
        db.prepare(
          `UPDATE ask_quota_reservations
              SET provider_usage_known = 1,
                  provider_tokens_used = provider_tokens_used + ?,
                  reserved_provider_tokens = 0, unknown_usage_charged = 0, updated_at = ?
            WHERE work_item_id = ?`,
        ).run(actualTokens, now, params.workItemId);
        db.prepare(
          `UPDATE ask_quota_buckets
              SET provider_tokens_reserved = MAX(0, provider_tokens_reserved - ?),
                  provider_tokens_used = MAX(0, provider_tokens_used + ?), updated_at = ?
            WHERE scope = 'installation' AND scope_key = ?`,
        ).run(
          application.reservedRelease,
          application.usedDelta,
          now,
          reservation.installation_scope_key,
        );
        return;
    }
  });
}

export function deleteExpiredAskQuotaState(
  db: DatabaseSync,
  retentionSeconds: number,
  batchSize: number,
) {
  let deleted = 0;
  const cutoff = Date.now() - retentionSeconds * 1000;
  for (;;) {
    const keys = readRows(
      db
        .prepare(
          `SELECT b.scope, b.scope_key
           FROM ask_quota_buckets b
          WHERE b.updated_at < ?
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
          LIMIT ?`,
        )
        .all(cutoff, batchSize),
      v.object({ scope: v.string(), scope_key: v.string() }),
    );
    const batch = keys.length;
    for (const key of keys) {
      db.prepare(`DELETE FROM ask_quota_buckets WHERE scope = ? AND scope_key = ?`).run(
        key.scope,
        key.scope_key,
      );
    }
    deleted += batch;
    if (batch < batchSize) return ((pinnedReturn: number) => pinnedReturn)(deleted);
  }
}
