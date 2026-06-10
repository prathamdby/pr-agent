import { describe, expect, it, vi, beforeEach } from "vitest";
import { ASK_FAILURE_MESSAGE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/agent/askSafety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/askSafety.js")>();
  return {
    ...actual,
    buildAskGithubTools: vi.fn(() => ({
      piTools: [
        {
          name: "listPullRequestFiles",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      ],
      executors: {
        listPullRequestFiles: vi.fn(async () => ({ files: [] })),
      },
    })),
  };
});

vi.mock("../src/agent/context7Tools.js", () => ({
  buildContext7Tools: vi.fn(() => ({ piTools: [], executors: {} })),
}));

const sendMock = vi.fn();
const restrictToToolsMock = vi.fn();
const restoreToolsMock = vi.fn();
const disposeMock = vi.fn(async () => undefined);

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: () => ({
    createSession: vi.fn(async () => ({
      send: sendMock,
      restrictToTools: restrictToToolsMock,
      restoreTools: restoreToolsMock,
      dispose: disposeMock,
    })),
  }),
}));

import { runAskHarness } from "../src/agent/askRunHarness.js";

const cfg = makeTestConfig({
  maxToolRounds: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  enableReviewLabelsEffort: false,
});

const askParams = {
  cfg,
  token: "t",
  tokenExpiresAtTs: Date.now() + 3_600_000,
  tokenTtlMs: 3_600_000,
  owner: "o",
  repo: "r",
  prNumber: 459,
  headSha: "sha",
  question: "Explain changes and provide a testing checklist.",
  replyTarget: { kind: "prConversation" as const, prNumber: 459 },
};

describe("runAskHarness finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tool-restricted finalize runs when investigation returns empty text", async () => {
    sendMock
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: "End-user summary and E2E checklist." });

    const result = await runAskHarness(askParams);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toEqual({ maxToolRounds: 12 });
    expect(sendMock.mock.calls[1]?.[1]).toBeUndefined();
    expect(restrictToToolsMock).toHaveBeenCalledWith([], {});
    expect(restoreToolsMock).toHaveBeenCalled();
    expect(result.answer).toContain("End-user summary and E2E checklist.");
    expect(result.answer).not.toContain("I'll examine");
  });

  it("posts failure message when investigation and finalize both return empty", async () => {
    sendMock.mockResolvedValue({ text: "" });

    const result = await runAskHarness(askParams);

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(restrictToToolsMock).toHaveBeenCalledWith([], {});
    expect(restoreToolsMock).toHaveBeenCalled();
    expect(result.answer).toContain(ASK_FAILURE_MESSAGE);
  });

  it("skips finalize when maxAskFinalizeRounds is zero", async () => {
    sendMock.mockResolvedValueOnce({ text: "" });

    const result = await runAskHarness({
      ...askParams,
      cfg: { ...cfg, maxAskFinalizeRounds: 0 },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(restrictToToolsMock).not.toHaveBeenCalled();
    expect(restoreToolsMock).not.toHaveBeenCalled();
    expect(result.answer).toContain(ASK_FAILURE_MESSAGE);
  });
});
