import { beforeEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import { buildSubmitReviewTool } from "../src/agent/submitReviewTool.js";
import { SECURITY_REVIEW_SUMMARY_SENTINEL } from "../src/agent/reviewSchema.js";

vi.mock("../src/agent/publishReview.js", () => ({
  publishReview: vi.fn(async () => undefined),
}));

import { publishReview } from "../src/agent/publishReview.js";

const cfg = {
  port: 3000,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  piProvider: "openai" as const,
  piModel: "gpt-4o-mini",
  maxToolRounds: 1,
  maxReviewPublishAttempts: 3,
  reviewConcurrency: 1,
  askConcurrency: 3,
  maxAskToolRounds: 12,
  webhookTimeoutMs: 10000,
  context7ApiKey: "",
  maxReviewFindings: 8,
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  logLevel: "info" as const,
};

describe("submitReview tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores duplicate submitReview after publish", async () => {
    const state = { published: false, inlinePublished: false, lastValidationError: null };
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
    });

    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };

    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("sets lastValidationError on malformed payload", async () => {
    const warnSpy = vi.spyOn(evlog, "logWarn");
    const state = { published: false, inlinePublished: false, lastValidationError: null };
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
    });

    await expect(executor({ prCharacter: "x" })).rejects.toThrow(
      /ReviewPayload validation failed/i,
    );
    expect(state.lastValidationError).toBeTruthy();
    expect(state.published).toBe(false);
    warnSpy.mockRestore();
  });

  it("mentions the security summary sentinel in the tool description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      mode: "review-security",
      state: { published: false, inlinePublished: false, lastValidationError: null },
    });
    expect(piTool.description).toContain(SECURITY_REVIEW_SUMMARY_SENTINEL);
  });
});
