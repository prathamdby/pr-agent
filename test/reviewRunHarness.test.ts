import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import {
  PRE_SUBMIT_REMINDER,
  PRE_SUBMIT_ROUND0_PROMPT,
} from "../src/review/prompts/reviewPromptBlocks.js";
import { PROSE_ONLY_NUDGE } from "../src/settings/index.js";

const sendMock = vi.fn(async (_message: string) => ({ text: "done" }));
const createSessionMock = vi.fn(async (_params: unknown) => ({
  send: sendMock,
  restrictToTools: vi.fn(),
  restoreTools: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

const nonEmptyDiffIndex = () => ({
  files: new Map([
    [
      "src/a.ts",
      {
        patchOmitted: false,
        commentableRightLineRanges: [[1, 5]],
        additions: 5,
        deletions: 0,
      },
    ],
  ]),
  truncated: false,
});

const emptyDiffIndex = () => ({
  files: new Map(),
  truncated: false,
});

let cachedDiffIndex = nonEmptyDiffIndex();
let submitState = {
  published: false,
  publishSuperseded: false,
  lastValidationError: null,
  publishCallCount: 0,
};

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 1, updated: true })),
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: vi.fn(() => ({
    createSession: createSessionMock,
  })),
}));

vi.mock("../src/review/run/reviewRunSetup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/reviewRunSetup.js")>();
  return {
    ...actual,
    buildReviewRunSetup: vi.fn((params) => ({
      systemPrompt: "system",
      userContent: "investigate",
      piTools: [],
      executors: {},
      cachedDiffIndex,
      submitState,
      getToken: () => params.token,
      getTokenExpiresAtTs: () => params.tokenExpiresAtTs,
      refreshBeforeTool: vi.fn(),
    })),
  };
});

import { runFullPrReview } from "../src/review/run/reviewRun.js";

const harnessConfigOverrides = {
  piModel: "test",
  maxToolRounds: 2,
  maxReviewPublishAttempts: 1,
  reviewAnchorMenuMaxFiles: 10,
  reviewAnchorMenuMaxRangesPerFile: 5,
};

describe("runFullPrReview harness behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cachedDiffIndex = nonEmptyDiffIndex();
    submitState = {
      published: false,
      publishSuperseded: false,
      lastValidationError: null,
      publishCallCount: 0,
    };
    sendMock.mockResolvedValue({ text: "done" });
  });

  const runHarness = async (overrides: Parameters<typeof makeTestConfig>[0] = {}) => {
    await runFullPrReview({
      cfg: makeTestConfig({
        ...harnessConfigOverrides,
        ...overrides,
      }),
      token: "tok",
      tokenExpiresAtTs: Date.now() + 60_000,
      tokenTtlMs: 60_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
      mode: "review",
      workspace: mockLocalPrWorkspace(),
    });
  };

  it("bundles the anchor menu into the first pre-submit send", async () => {
    await runHarness();

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0]?.[0]).toBe("investigate");
    expect(sendMock.mock.calls[1]?.[0]).toContain("commentable RIGHT-side line ranges");
    expect(sendMock.mock.calls[1]?.[0]).toContain("submitReview");
    expect(sendMock.mock.calls[2]?.[0]).toBe(PRE_SUBMIT_REMINDER);
  });

  it("keeps the round-0 prompt unchanged when the anchor menu is disabled", async () => {
    await runHarness({ reviewInjectAnchorMenu: false });

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0]?.[0]).toBe("investigate");
    expect(sendMock.mock.calls[1]?.[0]).toBe(
      [PRE_SUBMIT_ROUND0_PROMPT, PROSE_ONLY_NUDGE].join("\n\n"),
    );
    expect(sendMock.mock.calls[2]?.[0]).toBe(PRE_SUBMIT_REMINDER);
  });

  it("keeps the round-0 prompt unchanged when the diff index is empty", async () => {
    cachedDiffIndex = emptyDiffIndex();

    await runHarness();

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0]?.[0]).toBe("investigate");
    expect(sendMock.mock.calls[1]?.[0]).toBe(
      [PRE_SUBMIT_ROUND0_PROMPT, PROSE_ONLY_NUDGE].join("\n\n"),
    );
    expect(sendMock.mock.calls[2]?.[0]).toBe(PRE_SUBMIT_REMINDER);
  });

  it("skips anchor menu bundling when review stops after investigation", async () => {
    sendMock.mockImplementationOnce(async () => {
      submitState.publishSuperseded = true;
      return { text: "done" };
    });

    await runHarness();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe("investigate");
  });
});
