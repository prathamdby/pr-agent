import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublishSummaryTool,
  createSummaryCaptureState,
} from "../src/review/orchestrator/publishSummaryTool.js";

function overviewArgs(overrides: Record<string, unknown> = {}) {
  return {
    prCharacter: "Adds orchestrator publish tools.",
    estimatedEffort: 2,
    relevantTests: "partial" as const,
    securityConcerns: null,
    followUps: [],
    mergeVerdict: { score: 4, rationale: "Solid on this pass." },
    ...overrides,
  };
}

describe("publishSummaryTool (capture-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures once and latches duplicate success", async () => {
    const state = createSummaryCaptureState();
    const { executor, hasCaptured } = buildPublishSummaryTool({ state });

    const first = await executor(overviewArgs());
    expect(first).toEqual({
      accepted: true,
      value: {
        duplicate: false,
        overview: expect.objectContaining({ prCharacter: "Adds orchestrator publish tools." }),
      },
    });
    expect(hasCaptured()).toBe(true);
    expect(state.captured?.prCharacter).toContain("orchestrator");

    const second = await executor(overviewArgs({ prCharacter: "Should be ignored." }));
    expect(second).toEqual({
      accepted: true,
      value: {
        duplicate: true,
        overview: expect.objectContaining({ prCharacter: "Adds orchestrator publish tools." }),
      },
    });
  });

  it("stores structured validation errors for the repair loop without throwing", async () => {
    const state = createSummaryCaptureState();
    const { executor, getLastError, clearLastError } = buildPublishSummaryTool({ state });

    await expect(executor({ prCharacter: "" })).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining("prCharacter"),
    });
    expect(getLastError()).toEqual(expect.stringContaining("prCharacter"));
    expect(state.captured).toBeNull();

    clearLastError();
    expect(getLastError()).toBeNull();
  });
});
