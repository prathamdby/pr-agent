import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimitCircuit,
  shouldShortCircuitGithubTool,
  runWithRateLimitCircuit,
} from "../src/github/rateLimitCircuit.js";
import {
  getSharedRateLimitCircuit,
  isSharedRateLimitCircuitOpen,
  openSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort,
  upsertSharedRateLimitCircuit,
} from "../src/github/sharedRateLimitCircuit.js";
import * as evlog from "../src/evlog.js";
import { SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS } from "../src/settings/index.js";
import { createQueryPool } from "./helpers/fakePool.js";
import { isJsonNumber, isJsonString } from "../src/util/jsonValue.js";

type CircuitRow = {
  installation_id: number;
  open_until: Date;
  last_error_kind: string;
};

/** Minimal in-memory stand-in for two logical workers sharing one DB. */
function createMemorySharedCircuitStore() {
  const rows = new Map<number, CircuitRow>();

  function makePool() {
    return createQueryPool(async (text, values = []) => {
      if (text.includes("INSERT INTO github_installation_rate_limit_circuits")) {
        const installationIdRaw = values[0];
        const openUntilRaw = values[1];
        const lastErrorKindRaw = values[2];
        if (installationIdRaw instanceof Date || Buffer.isBuffer(installationIdRaw)) {
          throw new Error("expected numeric installation_id");
        }
        if (!isJsonNumber(installationIdRaw)) {
          throw new Error("expected numeric installation_id");
        }
        if (!(openUntilRaw instanceof Date)) {
          throw new Error("expected Date open_until");
        }
        if (lastErrorKindRaw instanceof Date || Buffer.isBuffer(lastErrorKindRaw)) {
          throw new Error("expected string last_error_kind");
        }
        if (!isJsonString(lastErrorKindRaw)) {
          throw new Error("expected string last_error_kind");
        }
        const existing = rows.get(installationIdRaw);
        if (!existing || openUntilRaw.getTime() >= existing.open_until.getTime()) {
          rows.set(installationIdRaw, {
            installation_id: installationIdRaw,
            open_until: openUntilRaw,
            last_error_kind: lastErrorKindRaw,
          });
        } else if (existing) {
          rows.set(installationIdRaw, {
            ...existing,
            last_error_kind: lastErrorKindRaw,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM github_installation_rate_limit_circuits")) {
        const installationIdRaw = values[0];
        if (installationIdRaw instanceof Date || Buffer.isBuffer(installationIdRaw)) {
          throw new Error("expected numeric installation_id");
        }
        if (!isJsonNumber(installationIdRaw)) {
          throw new Error("expected numeric installation_id");
        }
        const row = rows.get(installationIdRaw);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`unexpected SQL in memory store: ${text.slice(0, 80)}`);
    });
  }

  return { poolA: makePool(), poolB: makePool() };
}

describe("sharedRateLimitCircuit (cross-client MVP)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("process A marks circuit open → process B observes open and hydrates local short-circuit", async () => {
    const { poolA, poolB } = createMemorySharedCircuitStore();
    const installationId = 42;
    const now = new Date("2026-07-30T12:00:00.000Z");

    await openSharedRateLimitCircuit(poolA, {
      installationId,
      lastErrorKind: "secondary",
      cooldownMs: 60_000,
      now,
    });

    const stored = await getSharedRateLimitCircuit(poolB, installationId);
    expect(stored).not.toBeNull();
    expect(stored!.lastErrorKind).toBe("secondary");
    expect(stored!.openUntil.getTime()).toBe(now.getTime() + 60_000);

    expect(await isSharedRateLimitCircuitOpen(poolB, installationId, now)).toBe(true);
    expect(
      await isSharedRateLimitCircuitOpen(poolB, installationId, new Date(now.getTime() + 61_000)),
    ).toBe(false);

    // Worker B: new local circuit hydrates from shared state — no mutate/burst.
    const circuitB = createRateLimitCircuit({
      installationId,
      now: () => now.getTime(),
    });
    expect(circuitB.isOpen()).toBe(false);
    if (await isSharedRateLimitCircuitOpen(poolB, installationId, now)) {
      const shared = await getSharedRateLimitCircuit(poolB, installationId);
      circuitB.hydrateOpenFromShared("secondary", shared?.openUntil);
    }
    expect(circuitB.isOpen()).toBe(true);

    runWithRateLimitCircuit(circuitB, () => {
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(true);
      expect(shouldShortCircuitGithubTool("publish_summary")).toBe(false);
    });
  });

  it("upsert extends open_until with GREATEST semantics", async () => {
    const { poolA } = createMemorySharedCircuitStore();
    const installationId = 7;
    const t0 = new Date("2026-07-30T12:00:00.000Z");
    const t1 = new Date("2026-07-30T12:00:30.000Z");
    const earlier = new Date("2026-07-30T12:00:10.000Z");

    await upsertSharedRateLimitCircuit(poolA, {
      installationId,
      openUntil: new Date(t0.getTime() + 60_000),
      lastErrorKind: "primary",
    });
    await upsertSharedRateLimitCircuit(poolA, {
      installationId,
      openUntil: earlier,
      lastErrorKind: "secondary",
    });
    let row = await getSharedRateLimitCircuit(poolA, installationId);
    expect(row!.openUntil.getTime()).toBe(t0.getTime() + 60_000);
    expect(row!.lastErrorKind).toBe("secondary");

    await upsertSharedRateLimitCircuit(poolA, {
      installationId,
      openUntil: new Date(t1.getTime() + 60_000),
      lastErrorKind: "primary",
    });
    row = await getSharedRateLimitCircuit(poolA, installationId);
    expect(row!.openUntil.getTime()).toBe(t1.getTime() + 60_000);
  });

  it("openSharedRateLimitCircuit uses default SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS", async () => {
    const { poolA } = createMemorySharedCircuitStore();
    const now = new Date("2026-07-30T12:00:00.000Z");
    await openSharedRateLimitCircuit(poolA, {
      installationId: 9,
      lastErrorKind: "primary",
      now,
    });
    const row = await getSharedRateLimitCircuit(poolA, 9);
    expect(row!.openUntil.getTime()).toBe(now.getTime() + SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS);
  });

  it("best-effort open guards invalid input and swallows write failure", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    const pool = createQueryPool(query);

    openSharedRateLimitCircuitBestEffort(undefined, {
      installationId: 42,
      lastErrorKind: "primary",
    });
    openSharedRateLimitCircuitBestEffort(pool, {
      installationId: 0,
      lastErrorKind: "primary",
    });
    expect(query).not.toHaveBeenCalled();

    openSharedRateLimitCircuitBestEffort(pool, {
      installationId: 42,
      lastErrorKind: "primary",
    });
    await vi.waitFor(() => {
      expect(logWarn).toHaveBeenCalledWith(
        "github_shared_rate_limit_circuit_upsert_failed",
        expect.objectContaining({
          installationId: 42,
          kind: "primary",
          message: "db down",
        }),
      );
    });
  });
});
