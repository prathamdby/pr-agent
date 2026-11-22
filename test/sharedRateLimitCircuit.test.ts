import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimitCircuit,
  RATE_LIMIT_CIRCUIT_THRESHOLD,
  shouldShortCircuitGithubTool,
  runWithRateLimitCircuit,
} from "../src/github/rateLimitCircuit.ts";
import {
  isRateLimitCircuitOpen,
  openRateLimitCircuit,
  openRateLimitCircuitBestEffort,
  openRunRateLimitCircuit,
  readRateLimitCircuit,
  upsertRateLimitCircuit,
} from "../src/state/rateLimitCircuits.ts";
import * as evlog from "../src/evlog.ts";
import { SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS } from "../src/settings/index.ts";
import { openSqliteAppState } from "./integration/db.ts";

describe("sharedRateLimitCircuit (SQLite app_state)", () => {
  const handles: Array<{ close: () => void }> = [];

  function openDb() {
    const handle = openSqliteAppState();
    handles.push(handle);
    return handle.db;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) handles.pop()?.close();
  });

  it("run A marks circuit open → run B observes open and hydrates local short-circuit", () => {
    const db = openDb();
    const installationId = 42;
    const now = Date.parse("2026-07-30T12:00:00.000Z");

    openRateLimitCircuit(db, {
      installationId,
      lastErrorKind: "secondary",
      cooldownMs: 60_000,
      now,
    });

    const stored = readRateLimitCircuit(db, installationId);
    expect(stored).toBeDefined();
    expect(stored!.lastErrorKind).toBe("secondary");
    expect(stored!.openUntilMs).toBe(now + 60_000);

    expect(isRateLimitCircuitOpen(db, installationId, now)).toBe(true);
    expect(isRateLimitCircuitOpen(db, installationId, now + 61_000)).toBe(false);

    const circuitB = createRateLimitCircuit({
      installationId,
      now: () => now,
    });
    expect(circuitB.isOpen()).toBe(false);
    if (isRateLimitCircuitOpen(db, installationId, now)) {
      const shared = readRateLimitCircuit(db, installationId);
      circuitB.hydrateOpenFromShared(
        "secondary",
        shared ? new Date(shared.openUntilMs) : undefined,
      );
    }
    expect(circuitB.isOpen()).toBe(true);

    runWithRateLimitCircuit(circuitB, () => {
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(true);
      expect(shouldShortCircuitGithubTool("publish_summary")).toBe(false);
    });
  });

  it("upsert extends open_until with max semantics", () => {
    const db = openDb();
    const installationId = 7;
    const t0 = Date.parse("2026-07-30T12:00:00.000Z");
    const t1 = Date.parse("2026-07-30T12:00:30.000Z");
    const earlier = Date.parse("2026-07-30T12:00:10.000Z");

    upsertRateLimitCircuit(db, {
      installationId,
      openUntilMs: t0 + 60_000,
      lastErrorKind: "primary",
      now: t0,
    });
    upsertRateLimitCircuit(db, {
      installationId,
      openUntilMs: earlier,
      lastErrorKind: "secondary",
      now: t0 + 1_000,
    });
    let row = readRateLimitCircuit(db, installationId);
    expect(row!.openUntilMs).toBe(t0 + 60_000);
    expect(row!.lastErrorKind).toBe("secondary");

    upsertRateLimitCircuit(db, {
      installationId,
      openUntilMs: t1 + 60_000,
      lastErrorKind: "primary",
      now: t1,
    });
    row = readRateLimitCircuit(db, installationId);
    expect(row!.openUntilMs).toBe(t1 + 60_000);
  });

  it("openRateLimitCircuit uses default SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS", () => {
    const db = openDb();
    const now = Date.parse("2026-07-30T12:00:00.000Z");
    openRateLimitCircuit(db, {
      installationId: 9,
      lastErrorKind: "primary",
      now,
    });
    const row = readRateLimitCircuit(db, 9);
    expect(row!.openUntilMs).toBe(now + SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS);
  });

  it("best-effort open guards invalid input and swallows write failure", () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    const prepare = vi.fn(() => {
      throw new Error("db down");
    });
    const brokenDb = { prepare } as unknown as DatabaseSync;
    const now = Date.now();

    openRateLimitCircuitBestEffort(undefined, {
      installationId: 42,
      lastErrorKind: "primary",
      now,
    });
    openRateLimitCircuitBestEffort(brokenDb, {
      installationId: 0,
      lastErrorKind: "primary",
      now,
    });
    expect(prepare).not.toHaveBeenCalled();

    openRateLimitCircuitBestEffort(brokenDb, {
      installationId: 42,
      lastErrorKind: "primary",
      now,
    });
    expect(logWarn).toHaveBeenCalledWith(
      "github_shared_rate_limit_circuit_upsert_failed",
      expect.objectContaining({
        installationId: 42,
        kind: "primary",
        message: "db down",
      }),
    );
  });

  it("openRunRateLimitCircuit hydrates a run that starts inside an open shared window", () => {
    const db = openDb();
    const now = Date.parse("2026-07-30T12:00:00.000Z");
    openRateLimitCircuit(db, { installationId: 11, lastErrorKind: "secondary", now });

    const circuit = openRunRateLimitCircuit({
      db,
      installationId: 11,
      type: "review",
      workItemId: "wi-1",
      now: () => now,
    });

    expect(circuit.isOpen()).toBe(true);
  });

  it("openRunRateLimitCircuit continues the run when the shared read fails", () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    const brokenDb = {
      prepare: vi.fn(() => {
        throw new Error("db down");
      }),
    } as unknown as DatabaseSync;

    const circuit = openRunRateLimitCircuit({ db: brokenDb, installationId: 11, type: "review" });

    expect(circuit.isOpen()).toBe(false);
    expect(logWarn).toHaveBeenCalledWith(
      "github_shared_rate_limit_circuit_read_failed",
      expect.objectContaining({ type: "review", message: "db down" }),
    );
  });

  it("openRunRateLimitCircuit notifies the caller and publishes the tripped circuit", () => {
    const db = openDb();
    const now = Date.parse("2026-07-30T12:00:00.000Z");
    const onOpened = vi.fn();
    const circuit = openRunRateLimitCircuit({
      db,
      installationId: 12,
      type: "ask",
      onOpened,
      now: () => now,
    });

    for (let failure = 0; failure < RATE_LIMIT_CIRCUIT_THRESHOLD; failure += 1) {
      circuit.recordFailure("primary");
    }

    expect(onOpened).toHaveBeenCalledWith("primary");
    expect(isRateLimitCircuitOpen(db, 12, now)).toBe(true);
  });
});
