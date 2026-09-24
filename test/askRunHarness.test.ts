import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  ASK_FAILURE_MESSAGE,
  ASK_RETRY_NUDGE,
  ASK_SHORTEN_NUDGE,
  ASK_TRUNCATED_NOTICE,
} from "../src/settings/index.js";
import { CONTEXT7_RESPONSE_BYTES } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

vi.mock("../src/agent/tools/context7Tools.js", () => ({
  buildContext7Tools: vi.fn(() => ({ piTools: [], executors: {} })),
}));

vi.mock("../src/agent/tools/codeIndexTools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/tools/codeIndexTools.js")>();
  return {
    ...actual,
    buildCodeIndexTools: vi.fn(actual.buildCodeIndexTools),
  };
});

const sendMock = vi.fn();
const disposeMock = vi.fn(async () => undefined);

vi.mock("../src/agent/runtime/createFeatureSession.js", () => ({
  createFeaturePiSession: vi.fn(async () => ({
    role: "ask",
    send: sendMock,
    abort: vi.fn(async () => undefined),
    dispose: disposeMock,
  })),
}));

import { runAskRun } from "../src/agent/ask/askRun.js";
import { buildAskRunSetup } from "../src/agent/ask/askRunSetup.js";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { buildCodeIndexTools } from "../src/agent/tools/codeIndexTools.js";
import { buildContext7Tools } from "../src/agent/tools/context7Tools.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

const cfg = makeTestConfig({
  reviewConcurrency: 1,
  askConcurrency: 3,
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

  it("builds the shared Context7 tools with the ask configuration", async () => {
    sendMock.mockResolvedValue({ text: "Answer." });

    await runAskRun(askParams);

    expect(buildContext7Tools).toHaveBeenCalledWith({
      apiKey: cfg.context7ApiKey,
      maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
    });
  });
});

describe("runAskRun code index tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue({ text: "Answer." });
  });

  it("registers searchCodeIndex on the ask session", async () => {
    await runAskRun(askParams);

    expect(createFeaturePiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: "searchCodeIndex" })]),
      }),
    );
  });

  it("returns unavailable when the index is not configured", async () => {
    const { bundle } = buildAskRunSetup(askParams);
    const result = await bundle.executors.searchCodeIndex?.({ query: "auth" });
    expect(result).toEqual({ unavailable: true });
  });

  it("builds searchCodeIndex via buildCodeIndexTools when pool and snapshot are set", () => {
    const pool = {} as Pool;
    const { bundle } = buildAskRunSetup({
      ...askParams,
      pool,
      codeIndexSnapshotId: "snap-1",
    });

    expect(buildCodeIndexTools).toHaveBeenCalledWith({
      pool,
      snapshotId: "snap-1",
      workspace: askParams.workspace,
      pathGate: expect.anything(),
    });
    expect(bundle.piTools.map((tool) => tool.name)).toContain("searchCodeIndex");
    expect(bundle.executors.searchCodeIndex).toEqual(expect.any(Function));
  });
});
