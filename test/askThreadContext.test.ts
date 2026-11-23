import { describe, expect, it } from "vitest";
import {
  commentThreadGroups,
  type ThreadComment,
} from "../src/agent/discussion/pullRequestDiscussion.ts";

function comment(id: number, inReplyToId: number | null, authorLogin: string, body: string) {
  return ((pinnedReturn: ThreadComment) => pinnedReturn)({ id, inReplyToId, authorLogin, body });
}

describe("commentThreadGroups", () => {
  it("groups a reply cycle, a self-reply, and a missing parent by root id", () => {
    const all = [
      comment(1, 2, "a", "cycle"),
      comment(2, 1, "b", "cycle back"),
      comment(5, 5, "x", "self-ref"),
      comment(6, 5, "y", "child"),
      comment(8, 99, "z", "missing parent"),
    ];
    expect(commentThreadGroups(all).map((group) => group.map((entry) => entry.id))).toEqual([
      [1, 2],
      [5, 6],
      [8],
    ]);
  });
});
