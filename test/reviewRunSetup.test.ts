import { describe, expect, it } from "vitest";
import { createSubmitReviewState } from "../src/agent/submitReviewTool.js";
import { shouldContinueReviewRun } from "../src/agent/reviewRunSetup.js";

describe("shouldContinueReviewRun", () => {
  it("returns false when publishSuperseded is set", () => {
    const submitState = createSubmitReviewState();
    submitState.publishSuperseded = true;
    expect(shouldContinueReviewRun({ submitState })).toBe(false);
  });

  it("returns false when already published", () => {
    const submitState = createSubmitReviewState({ published: true });
    expect(shouldContinueReviewRun({ submitState })).toBe(false);
  });

  it("returns true while unpublished and not superseded", () => {
    const submitState = createSubmitReviewState();
    expect(shouldContinueReviewRun({ submitState })).toBe(true);
  });
});
