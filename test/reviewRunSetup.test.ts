import { describe, expect, it } from "vitest";
import { createSubmitReviewState } from "../src/review/publish/submitReviewTool.js";
import { REVIEWER_IDS } from "../src/review/prompts/reviewerPrompt.js";
import { buildReviewRunSetup, shouldContinueReviewRun } from "../src/review/run/reviewRunSetup.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

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

describe("buildReviewRunSetup roster defaults", () => {
  it("derives omittedReviewerIds from selectedReviewerIds when omitted is omitted", () => {
    const selected = ["correctness", "security", "tests", "maintainability"] as const;
    const setup = buildReviewRunSetup({
      cfg: makeTestConfig(),
      token: "t",
      tokenExpiresAtTs: Date.now() + 60_000,
      tokenTtlMs: 60_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      reviewMode: "review",
      workspace: mockLocalPrWorkspace(),
      selectedReviewerIds: selected,
    });
    expect(setup.selectedReviewerIds).toEqual([...selected]);
    expect(setup.omittedReviewerIds).toEqual(
      REVIEWER_IDS.filter((id) => !(selected as readonly string[]).includes(id)),
    );
  });
});
