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
import * as reviewRunMetrics from "../src/review/run/reviewRunMetrics.js";
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
      submitReview: publish,
    });

    await runWithRateLimitCircuit(circuit, async () => {
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(false);
      circuit.recordFailure("primary");
      expect(shouldShortCircuitGithubTool("searchCode")).toBe(true);
      expect(shouldShortCircuitGithubTool("submitReview")).toBe(false);
      expect(shouldShortCircuitGithubTool("readFile")).toBe(false);
      await expect(executors.searchCode!({})).resolves.toEqual({
        error: true,
        message: CIRCUIT_OPEN_TOOL_RESULT,
      });
      await expect(executors.submitReview!({})).resolves.toEqual({ published: true });
      expect(search).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  it("records exhausted primary and secondary throttle retries into the active circuit", () => {
    vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    vi.spyOn(evlog, "logInfo").mockImplementation(() => undefined);
    vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    const recordMetric = vi
      .spyOn(reviewRunMetrics, "recordReviewMetric")
      .mockImplementation(() => undefined);
    const circuit = createRateLimitCircuit({ installationId: 9, threshold: 1 });
    const options = { method: "GET", url: "/rate" } as never;

    runWithRateLimitCircuit(circuit, () => {
      expect(onRateLimit(1, options, {} as never, PRIMARY_RATE_LIMIT_MAX_RETRIES)).toBe(false);
      expect(circuit.isOpen()).toBe(true);
      expect(recordMetric).toHaveBeenCalledWith({ kind: "rate_limit_circuit_opened" });
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
});
