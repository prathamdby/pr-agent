import { describe, expect, it, vi } from "vitest";
import {
  isTransientGitHubReviewError,
  withTransientReviewRetry,
} from "../src/github/reviewPublishRetry.js";

describe("reviewPublishRetry", () => {
  it("treats non-line-resolution 422 as transient", () => {
    expect(
      isTransientGitHubReviewError({ status: 422, message: "Validation Failed temporarily" }),
    ).toBe(true);
  });

  it("does not treat line resolution 422 as transient", () => {
    expect(
      isTransientGitHubReviewError({ status: 422, message: "Line could not be resolved" }),
    ).toBe(false);
  });

  it("retries transient failures then succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 422, message: "Please retry" })
      .mockResolvedValueOnce("ok");

    const promise = withTransientReviewRetry(fn, [100]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
