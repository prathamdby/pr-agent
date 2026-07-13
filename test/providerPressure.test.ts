import { describe, expect, it } from "vitest";
import { deriveReviewProviderPressure } from "../src/agentWork/providerPressure.js";
import { makeTestConfig } from "./helpers/config.js";

describe("deriveReviewProviderPressure", () => {
  it("matches ADR 0022 max concurrent reviewer sessions formula", () => {
    const pressure = deriveReviewProviderPressure(
      makeTestConfig({ reviewConcurrency: 2, reviewAgentConcurrency: 4 }),
    );
    expect(pressure.maxConcurrentReviewerSessions).toBe(8);
    expect(pressure.reviewerRosterSize).toBe(8);
    expect(pressure.coreReviewerRosterSize).toBe(4);
    expect(pressure.reviewValidationMaxCandidates).toBe(16);
    expect(pressure.maxOrchestratorsPerReviewJob).toBe(1);
  });
});
