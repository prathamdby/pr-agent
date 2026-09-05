import { describe, expect, it } from "vitest";
import {
  isLineResolutionPublishError,
  isTransientGitHubReviewError,
} from "../src/github/reviewErrors.js";

describe("isTransientGitHubReviewError", () => {
  it("does not retry an ambiguous non-line-resolution 422", () => {
    expect(
      isTransientGitHubReviewError({
        status: 422,
        message: "Server busy; please try again",
      }),
    ).toBe(false);
  });

  it("retries when the provider proves rejection before acceptance", () => {
    expect(
      isTransientGitHubReviewError({
        status: 422,
        accepted: false,
        message: "Validation rejected before acceptance",
      }),
    ).toBe(true);
  });

  it("does not treat line resolution 422 as transient", () => {
    expect(
      isLineResolutionPublishError({
        status: 422,
        message: "Line could not be resolved",
      }),
    ).toBe(true);
    expect(
      isTransientGitHubReviewError({
        status: 422,
        message: "Line could not be resolved",
      }),
    ).toBe(false);
  });

  it("does not retry validation-failed 422", () => {
    expect(
      isTransientGitHubReviewError({
        status: 422,
        message: "Validation Failed: 422",
      }),
    ).toBe(false);
  });

  it("does not retry review-already-submitted 422", () => {
    expect(
      isTransientGitHubReviewError({
        status: 422,
        message: "Review has already been submitted on this pull request",
      }),
    ).toBe(false);
  });
});
