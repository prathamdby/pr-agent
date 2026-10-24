import { ASK_RETRY_NUDGE, ASK_SHORTEN_NUDGE } from "../src/prompts/ask/prompt.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ASK_FAILURE_MESSAGE, ASK_TRUNCATED_NOTICE } from "../src/settings/index.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";

const sendMock = vi.fn();
const disposeMock = vi.fn(async () => undefined);

vi.mock("../src/agent/runtime/createFeatureSession.ts", () => ({
  createFeaturePiSession: vi.fn(async () => ({
    role: "ask",
    send: sendMock,
    abort: vi.fn(async () => undefined),
    dispose: disposeMock,
  })),
}));

import { runAskRun } from "../src/agent/ask/askRun.ts";
import { emptyPullRequestDiscussion } from "../src/agent/discussion/pullRequestDiscussion.ts";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";

const cfg = makeTestConfig({
  concurrency: { review: 1, ask: 3 },
});

const { surface: prSurface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 459 });

const askParams = {
  cfg,
  prSurface,
  owner: "o",
  repo: "r",
  prNumber: 459,
  headSha: "sha",
  question: "Explain changes and provide a testing checklist.",
  replyTarget: { kind: "prConversation" as const, prNumber: 459 },
  workspace: mockLocalPrWorkspace(),
  discussion: emptyPullRequestDiscussion(),
};

describe("runAskRun finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prompt-only finalize runs when investigation returns empty text", async () => {
    sendMock
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: "End-user summary and E2E checklist." });

    const result = await runAskRun(askParams);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toEqual({
      maxToolRounds: 12,
      phase: "ask",
      checkpointId: "ask:ask",
    });
    expect(sendMock.mock.calls[1]?.[1]).toEqual({
      phase: "ask",
      checkpointId: "ask:ask",
      maxToolRounds: 0,
    });
    expect(result.answer).toContain("End-user summary and E2E checklist.");
    expect(result.answer).not.toContain("I'll examine");
    const sessionTools = vi.mocked(createFeaturePiSession).mock.calls[0]?.[0].tools ?? [];
    expect(sessionTools.map((tool) => tool.name)).not.toContain("resolveLibraryId");
    expect(sessionTools.map((tool) => tool.name)).not.toContain("getLibraryDocs");
  });

  it("posts failure message when investigation and finalize both return empty", async () => {
    sendMock.mockResolvedValue({ text: "" });

    const result = await runAskRun(askParams);

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(result.answer).toContain(ASK_FAILURE_MESSAGE);
  });

  it("retries a cut answer with a shorten nudge and posts the complete retry", async () => {
    sendMock
      .mockResolvedValueOnce({ text: "Long answer that was cut", end: "output_limit" })
      .mockResolvedValueOnce({ text: "Short complete answer.", end: "completed" });

    const result = await runAskRun(askParams);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1]?.[0]).toBe(ASK_SHORTEN_NUDGE);
    expect(result.answer).toContain("Short complete answer.");
    expect(result.answer).not.toContain(ASK_TRUNCATED_NOTICE);
  });

  it("keeps the last cut answer and marks it when every retry is cut or empty", async () => {
    sendMock
      .mockResolvedValueOnce({ text: "", end: "tool_budget" })
      .mockResolvedValueOnce({ text: "Cut answer", end: "output_limit" })
      .mockResolvedValueOnce({ text: "", end: "completed" });

    const result = await runAskRun(askParams);

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[1]?.[0]).toBe(ASK_RETRY_NUDGE);
    expect(sendMock.mock.calls[2]?.[0]).toBe(ASK_SHORTEN_NUDGE);
    expect(result.answer).toContain(`Cut answer\n\n${ASK_TRUNCATED_NOTICE}`);
    expect(result.answer).not.toContain(ASK_FAILURE_MESSAGE);
  });
});
