import { describe, expect, it } from "vitest";
import { reactionTargetsForWorkItem } from "../src/agentWork/reactionTargets.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

function baseItem() {
  return {
    id: "wi",
    webhookEventId: null,
    status: "running" as const,
    resourceKey: "o/r#1",
    attemptCount: 1,
    executionEpoch: 1,
    cancelRequestedAt: null,
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 9,
    headSha: "abc",
  };
}

describe("reactionTargetsForWorkItem", () => {
  it("prefers persisted ackTargets", () => {
    const item = {
      ...baseItem(),
      type: "review",
      source: "auto",
      reviewLens: "review",
      payload: {
        mode: "review",
        source: "auto",
        ackTargets: [
          { kind: "pr", prNumber: 1 },
          { kind: "issueComment", commentId: 44 },
        ],
      },
    } satisfies AgentWorkItem;

    expect(reactionTargetsForWorkItem(item)).toEqual([
      { kind: "pr", prNumber: 1 },
      { kind: "issueComment", commentId: 44 },
    ]);
  });

  it("rebuilds ask comment targets from replyTarget", () => {
    const item = {
      ...baseItem(),
      type: "ask",
      source: "slash",
      reviewLens: null,
      payload: {
        question: "why?",
        commentId: 12,
        replyTarget: { kind: "inlineReviewThread", prNumber: 1, inReplyToCommentId: 12 },
      },
    } satisfies AgentWorkItem;

    expect(reactionTargetsForWorkItem(item)).toEqual([
      { kind: "pr", prNumber: 1 },
      { kind: "reviewComment", commentId: 12 },
    ]);
  });

  it("falls back to PR-only for verification without stored targets", () => {
    const item = {
      ...baseItem(),
      type: "verification",
      source: "auto",
      reviewLens: null,
      payload: { source: "auto" },
    } satisfies AgentWorkItem;

    expect(reactionTargetsForWorkItem(item)).toEqual([{ kind: "pr", prNumber: 1 }]);
  });
});
