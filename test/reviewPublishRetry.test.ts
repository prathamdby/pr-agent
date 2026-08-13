import { describe, expect, it, vi } from "vitest";
import { withTransientReviewRetry } from "../src/github/reviewPublishRetry.js";
import {
  isLineResolutionPublishError,
  isTransientGitHubReviewError,
} from "../src/github/reviewErrors.js";

function githubError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("reviewPublishRetry", () => {
  it("treats non-line-resolution 422 as transient", () => {
    expect(isTransientGitHubReviewError(githubError(422, "Server busy; please try again"))).toBe(
      true,
    );
  });

  it("does not treat line resolution 422 as transient", () => {
    expect(isLineResolutionPublishError(githubError(422, "Line could not be resolved"))).toBe(true);
    expect(isTransientGitHubReviewError(githubError(422, "Line could not be resolved"))).toBe(
      false,
    );
  });

  it("does not retry validation-failed 422", () => {
    expect(isTransientGitHubReviewError(githubError(422, "Validation Failed: 422"))).toBe(false);
  });

  it("does not retry review-already-submitted 422", () => {
    expect(
      isTransientGitHubReviewError(
        githubError(422, "Review has already been submitted on this pull request"),
      ),
    ).toBe(false);
  });

  it("retries transient failures then succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(githubError(422, "Please retry"))
      .mockResolvedValueOnce("ok");

    const promise = withTransientReviewRetry(fn, [100]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
