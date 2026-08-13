import type { IntakeClient } from "../db/postgres.js";
import { queryOne } from "../db/postgres.js";
import { nonErrorThrown } from "../errors/appError.js";
import { logWarn } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS } from "../settings/index.js";
export type SharedRateLimitCircuitRow = {
  readonly installationId: number;
  readonly openUntil: Date;
  readonly lastErrorKind: string;
};

export async function upsertSharedRateLimitCircuit(
  client: IntakeClient,
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
  client: IntakeClient,
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
  client: IntakeClient,
  installationId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await getSharedRateLimitCircuit(client, installationId);
  if (!row) return false;
  return row.openUntil.getTime() > now.getTime();
}

/** Mark shared circuit open for the default MVP cooldown window. */
export async function openSharedRateLimitCircuit(
  client: IntakeClient,
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

/**
 * Best-effort shared open write from throttle/circuit paths.
 * Failures must not break the local circuit or the GitHub call path.
 */
export function openSharedRateLimitCircuitBestEffort(
  client: IntakeClient | undefined,
  params: {
    readonly installationId: number;
    readonly lastErrorKind: string;
    readonly cooldownMs?: number;
  },
): void {
  if (client == null || !Number.isFinite(params.installationId) || params.installationId <= 0) {
    return;
  }
  void openSharedRateLimitCircuit(client, params).catch((error) => {
    const err =
      error instanceof Error
        ? error
        : nonErrorThrown("github.shared_rate_limit_circuit_upsert_non_error_thrown");
    logWarn("github_shared_rate_limit_circuit_upsert_failed", {
      installationId: params.installationId,
      kind: params.lastErrorKind,
      message: sanitizeLogMessage(err.message),
    });
  });
}
