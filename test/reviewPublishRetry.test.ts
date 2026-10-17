import { describe, expect, it } from "vitest";
import {
  isDefinitelyNoAcceptanceReviewError,
  isLineResolutionPublishError,
} from "../src/github/reviewErrors.js";

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
});
