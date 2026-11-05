import { describe, expect, it } from "vitest";
import { isProvenInlineAnchorRejection } from "../src/github/githubErrors.ts";
import { isKnownNoAcceptanceMutationError } from "../src/github/mutationErrorContract.ts";
import {
  isDefinitelyNoAcceptanceReviewError,
  isInlineAnchorPublishError,
  isLineResolutionPublishError,
} from "../src/github/reviewErrors.ts";

describe("isDefinitelyNoAcceptanceReviewError", () => {
  it("does not treat an ambiguous non-line-resolution 422 as unaccepted", () => {
    expect(
      isDefinitelyNoAcceptanceReviewError({
        status: 422,
        message: "Server busy; please try again",
      }),
    ).toBe(false);
  });

  it("treats a provider-proven rejection before acceptance as unaccepted", () => {
    expect(
      isDefinitelyNoAcceptanceReviewError({
        status: 422,
        accepted: false,
        message: "Validation rejected before acceptance",
      }),
    ).toBe(true);
  });

  it("treats a line resolution 422 as unaccepted", () => {
    const error = { status: 422, message: "Line could not be resolved" };
    expect(isLineResolutionPublishError(error)).toBe(true);
    expect(isDefinitelyNoAcceptanceReviewError(error)).toBe(true);
  });

  it("does not treat validation-failed 422 as unaccepted", () => {
    expect(
      isDefinitelyNoAcceptanceReviewError({
        status: 422,
        message: "Validation Failed: 422",
      }),
    ).toBe(false);
  });

  it("does not treat review-already-submitted 422 as unaccepted", () => {
    expect(
      isDefinitelyNoAcceptanceReviewError({
        status: 422,
        message: "Review has already been submitted on this pull request",
      }),
    ).toBe(false);
  });

  it("treats a structured path rejection as unaccepted", () => {
    const error = {
      status: 422,
      message: "Path could not be resolved",
      response: {
        status: 422,
        data: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequestReview",
              code: "custom",
              message: "Path could not be resolved",
            },
          ],
        },
      },
    };
    expect(isProvenInlineAnchorRejection(error)).toBe(true);
    expect(isKnownNoAcceptanceMutationError(error)).toBe(true);
    expect(isInlineAnchorPublishError(error)).toBe(true);
    expect(isDefinitelyNoAcceptanceReviewError(error)).toBe(true);
  });

  it("does not treat a bare path message as unaccepted", () => {
    const error = new Error("Path could not be resolved");
    expect(isProvenInlineAnchorRejection(error)).toBe(false);
    expect(isKnownNoAcceptanceMutationError(error)).toBe(false);
    expect(isInlineAnchorPublishError(error)).toBe(false);
    expect(isDefinitelyNoAcceptanceReviewError(error)).toBe(false);
    expect(isLineResolutionPublishError(error)).toBe(false);
  });

  it("does not treat a mixed anchor and duplicate 422 as unaccepted", () => {
    const error = {
      status: 422,
      response: {
        data: {
          errors: [
            {
              resource: "PullRequestReview",
              code: "custom",
              message: "Path could not be resolved",
            },
            { resource: "PullRequestReview", code: "already_exists", message: "already exists" },
          ],
        },
      },
    };
    expect(isProvenInlineAnchorRejection(error)).toBe(false);
    expect(isDefinitelyNoAcceptanceReviewError(error)).toBe(false);
  });
});
