import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../src/errors/classifiedFailure.js";
import * as evlog from "../src/evlog.js";
import { publishReviewRunFailureNotice } from "../src/review/run/reviewRunFallback.js";
import { makeTestConfig } from "./helpers/config.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import { createEvidenceLedger } from "../src/review/findings/evidenceLedger.js";

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
        orchestratorUserContent: "",
        workspaceTools: { piTools: [], executors: {} },
        cachedDiffIndex: createCachedPrDiffIndex(),
        evidenceLedger: createEvidenceLedger("sha"),
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      },
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
