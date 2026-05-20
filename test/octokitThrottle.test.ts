import { describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import {
  onRateLimit,
  onSecondaryRateLimit,
  PRIMARY_RATE_LIMIT_MAX_RETRIES,
} from "../src/github/octokitThrottle.js";

describe("octokitThrottle hooks", () => {
  const options = { method: "GET", url: "https://api.github.com/repos/o/r/pulls/1" } as never;
  const octokit = {} as never;

  it("onRateLimit retries for retryCount 0 and 1", () => {
    const logSpy = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    expect(onRateLimit(30, options, octokit, 0)).toBe(true);
    expect(onRateLimit(30, options, octokit, 1)).toBe(true);
    expect(onRateLimit(30, options, octokit, PRIMARY_RATE_LIMIT_MAX_RETRIES)).toBe(false);
    logSpy.mockRestore();
  });

  it("onSecondaryRateLimit retries only when retryAfter > 0 and retryCount === 0", () => {
    const logSpy = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    expect(onSecondaryRateLimit(60, options, octokit, 0)).toBe(true);
    expect(onSecondaryRateLimit(60, options, octokit, 1)).toBe(false);
    expect(onSecondaryRateLimit(0, options, octokit, 0)).toBe(false);
    logSpy.mockRestore();
  });
});
