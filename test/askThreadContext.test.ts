import { describe, expect, it } from "vitest";
import {
  commentsInThread,
  formatThreadTranscript,
  type ThreadComment,
} from "../src/agent/ask/askThreadContext.js";

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

    expect(commentsInThread(all, 3).map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("returns empty when anchor is missing", () => {
    expect(commentsInThread([comment(1, null, "alice", "root")], 99)).toEqual([]);
  });
});

describe("formatThreadTranscript", () => {
  it("formats comments as login-prefixed blocks", () => {
    const { text, truncated } = formatThreadTranscript(
      [comment(1, null, "alice", "root question"), comment(2, 1, "bob", "follow-up")],
      10_000,
    );

    expect(truncated).toBe(false);
    expect(text).toBe("alice:\nroot question\n\nbob:\nfollow-up");
  });

  it("keeps root comment when truncating long threads", () => {
    const comments = [
      comment(1, null, "alice", "ROOT ANCHOR COMMENT"),
      comment(2, 1, "bob", "middle comment that should be omitted from the transcript"),
      comment(3, 2, "carol", "newest reply"),
    ];
    const maxChars = 74;

    const { text, truncated } = formatThreadTranscript(comments, maxChars);

    expect(truncated).toBe(true);
    expect(text.startsWith("alice:\nROOT ANCHOR COMMENT")).toBe(true);
    expect(text).toContain("…(earlier thread omitted)…");
    expect(text).toContain("carol:\nnewest reply");
    expect(text).not.toContain("middle comment");
  });
});
