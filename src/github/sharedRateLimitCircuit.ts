import type { Pool, PoolClient } from "pg";
import { queryOne } from "../db/postgres.ts";
import { logWarn } from "../evlog.ts";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.ts";
import { SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS } from "../settings/index.ts";
import { errorMessage } from "../errors/errorMessage.ts";
export type SharedRateLimitCircuitRow = {
  readonly installationId: number;
  readonly openUntil: Date;
  readonly lastErrorKind: string;
};

export async function upsertSharedRateLimitCircuit(
  client: Pool | PoolClient,
  params: {
    readonly installationId: number;
    readonly openUntil: Date;
    readonly lastErrorKind: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO github_installation_rate_limit_circuits (
       installation_id, open_until, last_error_kind
     ) VALUES ($1, $2, $3)
     ON CONFLICT (installation_id) DO UPDATE SET
       open_until = GREATEST(
         github_installation_rate_limit_circuits.open_until,
         EXCLUDED.open_until
       ),
       last_error_kind = EXCLUDED.last_error_kind`,
    [params.installationId, params.openUntil, params.lastErrorKind],
  );
}

export async function getSharedRateLimitCircuit(
  client: Pool | PoolClient,
  installationId: number,
): Promise<SharedRateLimitCircuitRow | null> {
  const row = await queryOne<{
    installation_id: string;
    open_until: Date;
    last_error_kind: string;
  }>(
    client,
    `SELECT installation_id, open_until, last_error_kind
       FROM github_installation_rate_limit_circuits
      WHERE installation_id = $1`,
    [installationId],
  );
  if (!row) return null;
  return {
    installationId: Number(row.installation_id),
    openUntil: row.open_until,
    lastErrorKind: row.last_error_kind,
  };
}

export async function isSharedRateLimitCircuitOpen(
  client: Pool | PoolClient,
  installationId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await getSharedRateLimitCircuit(client, installationId);
  if (!row) return false;
  return row.openUntil.getTime() > now.getTime();
}

export async function openSharedRateLimitCircuit(
  client: Pool | PoolClient,
  params: {
    readonly installationId: number;
    readonly lastErrorKind: string;
    readonly cooldownMs?: number;
    readonly now?: Date;
  },
): Promise<Date> {
  const now = params.now ?? new Date();
  const cooldownMs = params.cooldownMs ?? SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS;
  const openUntil = new Date(now.getTime() + cooldownMs);
  await upsertSharedRateLimitCircuit(client, {
    installationId: params.installationId,
    openUntil,
    lastErrorKind: params.lastErrorKind,
  });
  return openUntil;
}

export function openSharedRateLimitCircuitBestEffort(
  client: Pool | PoolClient | undefined,
  params: {
    readonly installationId: number;
    readonly lastErrorKind: string;
    readonly cooldownMs?: number;
  },
): void {
  if (client == null || !Number.isFinite(params.installationId) || params.installationId <= 0) {
    return;
  }
  void openSharedRateLimitCircuit(client, params).catch((error: unknown) => {
    logWarn("github_shared_rate_limit_circuit_upsert_failed", {
      installationId: params.installationId,
      kind: params.lastErrorKind,
      message: sanitizeLogMessage(errorMessage(error)),
    });
  });
}
