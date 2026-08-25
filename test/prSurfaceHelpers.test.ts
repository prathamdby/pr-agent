import { describe, expect, it } from "vitest";
import { findCommentIdByMarker } from "../src/github/prSurfaceHelpers.js";

describe("findCommentIdByMarker", () => {
  it("returns the newest marker match and supports author scoping", () => {
    const marker = "<!-- pr-agent:operation-intent marker -->";
    const comments = [
      { id: 1, inReplyToId: null, authorLogin: "pr-agent[bot]", body: marker },
      { id: 2, inReplyToId: null, authorLogin: "pr-agent[bot]", body: marker },
      { id: 3, inReplyToId: null, authorLogin: "human-reviewer", body: marker },
    ];

    expect(findCommentIdByMarker(comments, marker)).toBe(3);
    expect(
      findCommentIdByMarker(comments, marker, (comment) => comment.authorLogin === "pr-agent[bot]"),
    ).toBe(2);
  });
});
