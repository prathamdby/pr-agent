import { describe, expect, it } from "vitest";
import { assembleBotReviewThreads } from "../src/review/run/reviewPriorFeedback.js";

describe("maintainer decisions in assembled review threads", () => {
  it.each([
    [10, "OWNER", ["OWNER", "MEMBER", "COLLABORATOR"], true],
    [11, "MEMBER", ["OWNER", "MEMBER", "COLLABORATOR"], true],
    [12, "COLLABORATOR", ["OWNER", "MEMBER", "COLLABORATOR"], true],
    [13, "CONTRIBUTOR", ["OWNER", "MEMBER", "COLLABORATOR"], false],
    [14, "NONE", ["OWNER", "MEMBER", "COLLABORATOR"], false],
    [99, "OWNER", ["OWNER", "MEMBER", "COLLABORATOR"], false],
    [null, "OWNER", ["OWNER", "MEMBER", "COLLABORATOR"], false],
    [15, null, ["OWNER", "MEMBER", "COLLABORATOR"], false],
    [10, "NONE", ["*"], false],
    ...[" owner ", "Owner", "  collaborator ", "MeMbEr"].map(
      (association) => [10, association, ["OWNER", "MEMBER", "COLLABORATOR"], true] as const,
    ),
    ...["", "   ", undefined, "*", " * ", "\n*\t"].map(
      (association) => [10, association, ["*"], false] as const,
    ),
  ] as const)(
    "classifies user %s association %j with allowed %j",
    (userId, authorAssociation, allowed, expected) => {
      const [thread] = assembleBotReviewThreads(
        [
          {
            id: 1,
            inReplyToId: null,
            pullRequestReviewId: 7,
            userId: 99,
            body: "Finding",
            path: "src/x.ts",
            line: 4,
            originalLine: 4,
            htmlUrl: "https://github.com/o/r/pull/1#discussion_r1",
          },
          {
            id: 2,
            inReplyToId: 1,
            pullRequestReviewId: 7,
            userId,
            authorAssociation,
            body: "Dismiss",
            path: "src/x.ts",
            line: 4,
            originalLine: 4,
            htmlUrl: "https://github.com/o/r/pull/1#discussion_r2",
          },
        ],
        {
          botUserId: 99,
          reviewLenses: new Map([[7, "review"]]),
          allowedLenses: new Set(["review"]),
          maintainerDecisionAssociations: new Set(allowed),
        },
      );
      expect(thread?.authorizedReplies).toEqual(expected ? ["Dismiss"] : []);
      expect(thread?.untrustedReplies).toEqual(!expected && userId !== 99 ? ["Dismiss"] : []);
    },
  );
});
