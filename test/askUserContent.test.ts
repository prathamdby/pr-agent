import { describe, expect, it } from "vitest";
import { buildAskUserContent } from "../src/agent/ask/askUserContent.js";
import type { AskRunParams } from "../src/agent/ask/askRunTypes.js";
import { makeTestConfig } from "./helpers/config.js";

function baseParams(overrides: Partial<AskRunParams> = {}): AskRunParams {
  return {
    cfg: makeTestConfig(),
    token: "t",
    tokenExpiresAtTs: Date.now() + 60_000,
    tokenTtlMs: 60_000,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "abc",
    question: "why?",
    replyTarget: { kind: "prConversation", prNumber: 1 },
    workspace: {} as AskRunParams["workspace"],
    ...overrides,
  };
}

describe("buildAskUserContent thread_transcript", () => {
  it("includes chronological header when transcript is present and not truncated", () => {
    const content = buildAskUserContent(
      baseParams({ threadTranscript: "alice:\nhello", threadTranscriptTruncated: false }),
    );
    expect(content).toContain("thread_transcript");
    expect(content).toContain("chronological");
    expect(content).not.toContain("truncated for length");
  });

  it("includes truncated header when threadTranscriptTruncated is true", () => {
    const content = buildAskUserContent(
      baseParams({ threadTranscript: "alice:\nhello", threadTranscriptTruncated: true }),
    );
    expect(content).toContain("truncated for length");
  });

  it("does not include thread_transcript block when transcript is whitespace", () => {
    const content = buildAskUserContent(
      baseParams({ threadTranscript: "   ", threadTranscriptTruncated: false }),
    );
    expect(content).not.toContain("thread_transcript");
  });
});
