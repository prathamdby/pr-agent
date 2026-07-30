import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createRateLimitCircuit,
  shouldShortCircuitGithubTool,
  runWithRateLimitCircuit,
} from "../src/github/rateLimitCircuit.js";
import {
  getSharedRateLimitCircuit,
  isSharedRateLimitCircuitOpen,
  openSharedRateLimitCircuit,
  upsertSharedRateLimitCircuit,
} from "../src/github/sharedRateLimitCircuit.js";

type CircuitRow = {
  installation_id: number;
  open_until: Date;
  last_error_kind: string;
};

/** Minimal in-memory stand-in for two logical workers sharing one DB. */
function createMemorySharedCircuitStore(): {
  poolA: Pool;
  poolB: Pool;
} {
  const rows = new Map<number, CircuitRow>();

  function makePool(): Pool {
    return {
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes("INSERT INTO github_installation_rate_limit_circuits")) {
          const installationId = Number(values[0]);
          const openUntil = values[1] as Date;
          const lastErrorKind = String(values[2]);
          const existing = rows.get(installationId);
          if (!existing || openUntil.getTime() >= existing.open_until.getTime()) {
            rows.set(installationId, {
              installation_id: installationId,
              open_until: openUntil,
              last_error_kind: lastErrorKind,
            });
          } else if (existing) {
            rows.set(installationId, {
              ...existing,
              last_error_kind: lastErrorKind,
            });
          }
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("FROM github_installation_rate_limit_circuits")) {
          const installationId = Number(values[0]);
          const row = rows.get(installationId);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        throw new Error(`unexpected SQL in memory store: ${text.slice(0, 80)}`);
      },
    } as unknown as Pool;
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
    const circuitB = createRateLimitCircuit({ installationId });
    expect(circuitB.isOpen()).toBe(false);
    if (await isSharedRateLimitCircuitOpen(poolB, installationId, now)) {
      circuitB.hydrateOpenFromShared("secondary");
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
});
