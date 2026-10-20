import { describe, expect, it } from "vitest";
import {
  commentThreadGroups,
  commentsInThread,
  type ThreadComment,
} from "../src/agent/discussion/pullRequestDiscussion.ts";

function comment(
  id: number,
  inReplyToId: number | null,
  authorLogin: string,
  body: string,
): ThreadComment {
  return { id, inReplyToId, authorLogin, body };
}

describe("commentsInThread", () => {
  it("returns comments sharing the same root", () => {
    const all = [
      comment(1, null, "alice", "root"),
      comment(2, 1, "bob", "reply one"),
      comment(3, 2, "carol", "reply two"),
      comment(9, null, "other", "other thread"),
    ];

    expect(commentsInThread(all, 3).map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("returns empty when anchor is missing", () => {
    expect(commentsInThread([comment(1, null, "alice", "root")], 99)).toEqual([]);
  });

  it("treats self-referencing inReplyToId as the thread root", () => {
    const all = [comment(5, 5, "x", "self-ref"), comment(6, 5, "y", "child")];
    expect(commentsInThread(all, 6).map((entry) => entry.id)).toEqual([5, 6]);
  });
});

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
