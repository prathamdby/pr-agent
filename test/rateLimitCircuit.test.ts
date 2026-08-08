import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_OPEN_TOOL_RESULT,
  createRateLimitCircuit,
  getActiveRateLimitCircuit,
  noteGithubRequestSuccess,
  noteRateLimitRetryExhausted,
  RATE_LIMIT_CIRCUIT_THRESHOLD,
  runWithRateLimitCircuit,
  shouldShortCircuitGithubTool,
  wrapExecutorsWithRateLimitCircuit,
} from "../src/github/rateLimitCircuit.js";
import { onRateLimit, onSecondaryRateLimit } from "../src/github/octokitThrottle.js";
import {
  PRIMARY_RATE_LIMIT_MAX_RETRIES,
  SECONDARY_RATE_LIMIT_MAX_RETRIES,
} from "../src/settings/index.js";
import * as evlog from "../src/evlog.js";

describe("rateLimitCircuit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens after three consecutive primary failures and resets on success", () => {
    const opened = vi.fn();
    const circuit = createRateLimitCircuit({ installationId: 7, onOpened: opened });
    expect(circuit.recordFailure("primary")).toBe(false);
    expect(circuit.recordFailure("primary")).toBe(false);
    circuit.recordSuccess();
    expect(circuit.consecutiveFailures()).toBe(0);
    expect(circuit.recordFailure("primary")).toBe(false);
    expect(circuit.recordFailure("secondary")).toBe(false);
    expect(circuit.recordFailure("primary")).toBe(true);
    expect(circuit.isOpen()).toBe(true);
    expect(opened).toHaveBeenCalledWith("primary");
    expect(circuit.recordFailure("secondary")).toBe(false);
  });

  it("isolates circuit state per installation/run", () => {
    const a = createRateLimitCircuit({ installationId: 1 });
    const b = createRateLimitCircuit({ installationId: 2 });
    for (let i = 0; i < RATE_LIMIT_CIRCUIT_THRESHOLD; i += 1) a.recordFailure("primary");
    expect(a.isOpen()).toBe(true);
    expect(b.isOpen()).toBe(false);
    expect(getActiveRateLimitCircuit()).toBeUndefined();
    runWithRateLimitCircuit(b, () => {
      expect(getActiveRateLimitCircuit()).toBe(b);
      noteRateLimitRetryExhausted("secondary");
      noteRateLimitRetryExhausted("secondary");
      noteRateLimitRetryExhausted("secondary");
      expect(b.isOpen()).toBe(true);
      expect(a.isOpen()).toBe(true);
    });
  });

  it("short-circuits nonessential GitHub tools only when open", async () => {
    const circuit = createRateLimitCircuit({ installationId: 3, threshold: 1 });
    const search = vi.fn(async () => ({ ok: true }));
    const publish = vi.fn(async () => ({ published: true }));
    const executors = wrapExecutorsWithRateLimitCircuit({
      searchCode: search,
      publish_summary: publish,
    });

    await runWithRateLimitCircuit(circuit, async () => {
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(false);
      circuit.recordFailure("primary");
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(true);
      expect(shouldShortCircuitGithubTool("publish_summary")).toBe(false);
      expect(shouldShortCircuitGithubTool("readFile")).toBe(false);
      await expect(executors.searchCode!({})).resolves.toEqual({
        error: true,
        message: CIRCUIT_OPEN_TOOL_RESULT,
      });
      await expect(executors.publish_summary!({})).resolves.toEqual({ published: true });
      expect(search).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  it("records exhausted primary and secondary throttle retries into the active circuit", () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    vi.spyOn(evlog, "logInfo").mockImplementation(() => undefined);
    vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    const circuit = createRateLimitCircuit({ installationId: 9, threshold: 1 });
    const options = { method: "GET", url: "/rate" } as never;

    runWithRateLimitCircuit(circuit, () => {
      expect(onRateLimit(1, options, {} as never, PRIMARY_RATE_LIMIT_MAX_RETRIES)).toBe(false);
      expect(circuit.isOpen()).toBe(true);
      expect(logWarn).toHaveBeenCalledWith(
        "github_rate_limit_circuit_opened",
        expect.objectContaining({ installationId: 9, kind: "primary" }),
      );
    });

    const secondary = createRateLimitCircuit({ installationId: 10, threshold: 1 });
    runWithRateLimitCircuit(secondary, () => {
      expect(
        onSecondaryRateLimit(0, options, {} as never, SECONDARY_RATE_LIMIT_MAX_RETRIES - 1),
      ).toBe(false);
      expect(secondary.isOpen()).toBe(true);
    });
  });

  it("resets consecutive failures after a successful GitHub request in context", () => {
    const circuit = createRateLimitCircuit({ installationId: 11 });
    runWithRateLimitCircuit(circuit, () => {
      circuit.recordFailure("primary");
      circuit.recordFailure("primary");
      noteGithubRequestSuccess();
      expect(circuit.consecutiveFailures()).toBe(0);
      expect(circuit.isOpen()).toBe(false);
    });
  });

  it("closes a shared-hydrated circuit after openUntil expires", () => {
    let nowMs = 1_000_000;
    const circuit = createRateLimitCircuit({
      installationId: 12,
      now: () => nowMs,
    });
    circuit.hydrateOpenFromShared("primary", new Date(nowMs + 5_000));
    expect(circuit.isOpen()).toBe(true);
    nowMs += 5_000;
    expect(circuit.isOpen()).toBe(false);
  });

  it("keeps a locally opened circuit open after shared cooldown would expire", () => {
    const t0 = 1_000_000;
    const circuit = createRateLimitCircuit({
      installationId: 13,
      threshold: 1,
      now: () => t0 + 120_000,
    });
    circuit.recordFailure("primary");
    expect(circuit.isOpen()).toBe(true);
  });

  it("does not hydrate when shared openUntil is already expired", () => {
    const t0 = 2_000_000;
    const circuit = createRateLimitCircuit({
      installationId: 14,
      now: () => t0,
    });
    circuit.hydrateOpenFromShared("secondary", new Date(t0 - 1));
    expect(circuit.isOpen()).toBe(false);
  });
});
