import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { readRow } from "./db.ts";
import { logInfo, logWarn } from "../evlog.ts";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.ts";
import { SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS } from "../settings/index.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import { createRateLimitCircuit, type RateLimitFailureClass } from "../github/rateLimitCircuit.ts";

export type RateLimitCircuitState = {
  readonly openUntilMs: number;
  readonly lastErrorKind: string;
};

export function upsertRateLimitCircuit(
  db: DatabaseSync,
  params: {
    readonly installationId: number;
    readonly openUntilMs: number;
    readonly lastErrorKind: string;
    readonly now: number;
  },
) {
  const existing = readRateLimitCircuit(db, params.installationId);
  const openUntilMs = Math.max(existing?.openUntilMs ?? 0, params.openUntilMs);
  const state: RateLimitCircuitState = { openUntilMs, lastErrorKind: params.lastErrorKind };
  db.prepare(
    `INSERT INTO rate_limit_circuits (installation_id, state_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (installation_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
  ).run(params.installationId, JSON.stringify(state), params.now);
}

export function readRateLimitCircuit(db: DatabaseSync, installationId: number) {
  const row = readRow(
    db
      .prepare(`SELECT state_json FROM rate_limit_circuits WHERE installation_id = ?`)
      .get(installationId),
    v.object({ state_json: v.optional(v.string()) }),
  );
  if (row?.state_json == null)
    return ((pinnedReturn: RateLimitCircuitState | undefined) => pinnedReturn)(undefined);
  try {
    const parsed = v.parse(
      v.object({
        openUntilMs: v.optional(v.unknown()),
        lastErrorKind: v.optional(v.unknown()),
      }),
      JSON.parse(row.state_json),
    );
    if (typeof parsed.openUntilMs !== "number")
      return ((pinnedReturn: RateLimitCircuitState | undefined) => pinnedReturn)(undefined);
    return ((pinnedReturn: RateLimitCircuitState | undefined) => pinnedReturn)({
      openUntilMs: parsed.openUntilMs,
      lastErrorKind: typeof parsed.lastErrorKind === "string" ? parsed.lastErrorKind : "unknown",
    });
  } catch {
    return ((pinnedReturn: RateLimitCircuitState | undefined) => pinnedReturn)(undefined);
  }
}

export function isRateLimitCircuitOpen(db: DatabaseSync, installationId: number, now: number) {
  const row = readRateLimitCircuit(db, installationId);
  return ((pinnedReturn: boolean) => pinnedReturn)(row !== undefined && row.openUntilMs > now);
}

export function openRateLimitCircuit(
  db: DatabaseSync,
  params: {
    readonly installationId: number;
    readonly lastErrorKind: string;
    readonly cooldownMs?: number;
    readonly now: number;
  },
) {
  const openUntilMs = params.now + (params.cooldownMs ?? SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS);
  upsertRateLimitCircuit(db, {
    installationId: params.installationId,
    openUntilMs,
    lastErrorKind: params.lastErrorKind,
    now: params.now,
  });
  return ((pinnedReturn: number) => pinnedReturn)(openUntilMs);
}

export function openRateLimitCircuitBestEffort(
  db: DatabaseSync | undefined,
  params: {
    readonly installationId: number;
    readonly lastErrorKind: string;
    readonly cooldownMs?: number;
    readonly now: number;
  },
) {
  if (db == null || !Number.isFinite(params.installationId) || params.installationId <= 0) return;
  try {
    openRateLimitCircuit(db, params);
  } catch (error) {
    logWarn("github_shared_rate_limit_circuit_upsert_failed", {
      installationId: params.installationId,
      kind: params.lastErrorKind,
      message: sanitizeLogMessage(errorMessage(error)),
    });
  }
}

export function openRunRateLimitCircuit(params: {
  readonly db: DatabaseSync | undefined;
  readonly installationId: number;
  readonly type: "ask" | "review";
  readonly workItemId?: string;
  readonly onOpened?: (kind: RateLimitFailureClass) => void;
  readonly now?: () => number;
}) {
  const now = params.now ?? Date.now;
  const logIdentity = {
    installationId: params.installationId,
    type: params.type,
    ...(params.workItemId != null ? { workItemId: params.workItemId } : {}),
  };
  const circuit = createRateLimitCircuit({
    installationId: params.installationId,
    now,
    onOpened: (kind) => {
      params.onOpened?.(kind);
      openRateLimitCircuitBestEffort(params.db, {
        installationId: params.installationId,
        lastErrorKind: kind,
        now: now(),
      });
    },
  });
  if (params.db == null || params.installationId <= 0) return circuit;
  try {
    const shared = readRateLimitCircuit(params.db, params.installationId);
    if (shared !== undefined && shared.openUntilMs > now()) {
      circuit.hydrateOpenFromShared(
        shared.lastErrorKind === "secondary" ? "secondary" : "primary",
        new Date(shared.openUntilMs),
      );
      logInfo("github_shared_rate_limit_circuit_honored", logIdentity);
    }
  } catch (error) {
    logWarn("github_shared_rate_limit_circuit_read_failed", {
      ...logIdentity,
      message: errorMessage(error),
    });
  }
  return circuit;
}
