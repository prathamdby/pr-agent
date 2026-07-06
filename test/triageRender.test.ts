import { describe, expect, it } from "vitest";
import { renderTriageReport } from "../src/agent/triage/triageRender.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { TriagePayload } from "../src/review/triageSchema.js";

function thread(
  rootCommentId: number,
  overrides: Partial<BotFindingThread> = {},
): BotFindingThread {
  return {
    rootCommentId,
    lens: "review",
    path: "src/app.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "P1 · Bug",
    humanReplies: [],
    threadUrl: "https://github.test/thread",
    ...overrides,
  };
}

describe("renderTriageReport policy suggestion footer", () => {
  it("does not add a policy suggestion footer when there are no dismissed verdicts", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1)],
      payload: {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: "b".repeat(40), evidence: "done" },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
    });

    expect(result).not.toContain("Policy suggestions");
  });

  it("adds a policy suggestion footer for dismissed verdicts", () => {
    const result = renderTriageReport({
      headSha: "a".repeat(40),
      inventory: [thread(1, { path: "src/auth/login.ts" }), thread(2, { path: "src/other.ts" })],
      payload: {
        verdicts: [
          {
            verdict: "dismissed",
            threadRootCommentId: 1,
            evidence: "False positive: input is sanitized upstream.",
          },
          {
            verdict: "fixed",
            threadRootCommentId: 2,
            commitSha: "b".repeat(40),
            evidence: "fixed",
          },
        ],
      } as TriagePayload,
      commits: [],
      previouslyResolvedCount: 0,
    });

    expect(result).toContain("Policy suggestions for dismissed findings");
    expect(result).toContain('path: "src/auth/login.ts"');
    expect(result).toContain("False positive: input is sanitized upstream.");
    // The non-dismissed thread should not appear in the suggestions
    const suggestionSection = result.split("Policy suggestions")[1];
    expect(suggestionSection).not.toContain("src/other.ts");
  });
});
