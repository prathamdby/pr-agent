import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

const sendMock = vi.fn(async () => ({ text: "done" }));
const createSessionMock = vi.fn(async () => ({
  send: sendMock,
  restrictToTools: vi.fn(),
  restoreTools: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 1, updated: true })),
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: vi.fn(() => ({
    createSession: createSessionMock,
  })),
}));

vi.mock("../src/review/reviewRunSetup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/reviewRunSetup.js")>();
  return {
    ...actual,
    buildReviewRunSetup: vi.fn((params) => ({
      systemPrompt: "system",
      userContent: "investigate",
      piTools: [],
      executors: {},
      cachedDiffIndex: {
        files: new Map([
          [
            "src/a.ts",
            {
              patchOmitted: false,
              commentableRightLineRanges: [[1, 5]],
            },
          ],
        ]),
        truncated: false,
      },
      submitState: {
        published: false,
        publishSuperseded: false,
        lastValidationError: null,
        publishCallCount: 0,
      },
      getToken: () => params.token,
      refreshBeforeTool: vi.fn(),
    })),
  };
});

import { runReviewHarness } from "../src/review/reviewRunHarness.js";

const cfg = {
  agentProvider: "pi",
  piModel: "test",
  maxToolRounds: 2,
  maxReviewPublishAttempts: 1,
  maxReviewPublishCalls: 2,
  reviewInjectAnchorMenu: true,
  reviewAnchorMenuMaxFiles: 10,
  reviewAnchorMenuMaxRangesPerFile: 5,
} as Config;

describe("runReviewHarness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue({ text: "done" });
  });

  it("runs investigation, anchor menu, and pre-submit sends in order", async () => {
    await runReviewHarness({
      cfg,
      token: "tok",
      tokenExpiresAtTs: Date.now() + 60_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
      reviewMode: "review",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(sendMock.mock.calls[0]?.[0]).toBe("investigate");
    expect(String(sendMock.mock.calls[1]?.[0])).toContain("commentable RIGHT-side line ranges");
    expect(String(sendMock.mock.calls[2]?.[0])).toContain("submitReview");
    expect(String(sendMock.mock.calls[3]?.[0])).toContain("submitReview");
  });
});
