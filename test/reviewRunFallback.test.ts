import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../src/errors/classifiedFailure.ts";
import * as evlog from "../src/evlog.ts";
import { publishReviewRunFailureNotice } from "../src/review/run/reviewRunFallback.ts";
import type { ReviewRunSetup } from "../src/review/run/reviewRunSetup.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";

vi.mock("../src/github/reviewPublish.ts", () => ({
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
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      } as ReviewRunSetup,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewMode: "review",
      publishAttempts: 2,
      lastFailure,
      findingView: {
        completeness: "complete",
        rows: [],
        blockingCount: 0,
        suppressedDismissedCount: 0,
        duplicates: [],
      },
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
