import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../src/errors/classifiedFailure.js";
import * as evlog from "../src/evlog.js";
import { publishReviewRunFailureNotice } from "../src/review/run/reviewRunFallback.js";
import type { ReviewRunSetup } from "../src/review/run/reviewRunSetup.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 1 })),
}));

describe("publishReviewRunFailureNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs agent_publish_fallback with classified lastFailure fields", async () => {
    const warnSpy = vi.spyOn(evlog, "logWarn");
    const lastFailure = classifyFailure(new Error("Insufficient credits"), {
      phase: "synthesis",
    });
    await publishReviewRunFailureNotice({
      cfg: makeTestConfig(),
      setup: {
        getToken: () => "tok",
        getTokenExpiresAtTs: () => Date.now() + 60_000,
      } as ReviewRunSetup,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewMode: "review",
      publishAttempts: 2,
      lastFailure,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "agent_publish_fallback",
      expect.objectContaining({
        mode: "review",
        publishAttempts: 2,
        failureDomain: "provider",
        errorKind: "quota",
        errorMessage: expect.stringMatching(/credit/i),
      }),
    );
  });
});
