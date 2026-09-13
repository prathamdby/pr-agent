import { describe, expect, it } from "vitest";
import { buildAskUserContent } from "../src/agent/ask/askUserContent.js";
import type { AskRunParams } from "../src/agent/ask/askRunTypes.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { makeTestConfig } from "./helpers/config.js";

function baseParams(overrides: Partial<AskRunParams> = {}): AskRunParams {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  return {
    cfg: makeTestConfig(),
    prSurface: surface,
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

  it("includes a read-only ci_state block from durable facts", () => {
    const content = buildAskUserContent(
      baseParams({
        ciState: {
          rollup: "failing",
          version: 3,
          checks: [{ name: "lint", status: "completed", conclusion: "failure" }],
        },
      }),
    );
    expect(content).toContain('<ci_state untrusted="true">');
    expect(content).toContain("rollup: failing");
    expect(content).toContain("- lint: completed/failure");
  });

  it("omits ci_state when facts were not loaded", () => {
    const content = buildAskUserContent(baseParams());
    expect(content).not.toContain("ci_state");
  });
});
