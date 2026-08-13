import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { ASK_FAILURE_MESSAGE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

import {
  resetCreateFeaturePiSession,
  setCreateFeaturePiSession,
} from "../src/agent/runtime/createFeatureSession.js";
import { EMPTY_STRUCTURED_STATE, type PiSession } from "../src/agent/runtime/types.js";
import * as context7Tools from "../src/agent/tools/context7Tools.js";
import { runAskRun } from "../src/agent/ask/askRun.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

const cfg = makeTestConfig({
  reviewConcurrency: 1,
  askConcurrency: 3,
});

const { surface: prSurface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 459 });

const sendMock = vi.fn();
const disposeMock = vi.fn(async () => undefined);

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
};

function fakeAskSession(): PiSession {
  const session: PiSession = {
    role: "ask",
    primary: { provider: cfg.piProvider, model: cfg.piModel },
    send: sendMock,
    abort: async () => undefined,
    dispose: disposeMock,
    restartWithFallback: async () => session,
    getStructuredState: () => EMPTY_STRUCTURED_STATE,
    setStructuredState: () => undefined,
  };
  return session;
}

describe("runAskRun finalize", () => {
  beforeEach(() => {
    vi.spyOn(context7Tools, "buildContext7Tools").mockReturnValue({
      piTools: [],
      executors: {
        resolveLibraryId: async () => ({ content: "", truncated: false, returnedBytes: 0 }),
        getLibraryDocs: async () => ({ content: "", truncated: false, returnedBytes: 0 }),
      },
    });
    setCreateFeaturePiSession(vi.fn(async () => fakeAskSession()));
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetCreateFeaturePiSession();
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
  });

  it("posts failure message when investigation and finalize both return empty", async () => {
    sendMock.mockResolvedValue({ text: "" });

    const result = await runAskRun(askParams);

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(result.answer).toContain(ASK_FAILURE_MESSAGE);
  });
});
