import { describe, expect, it } from "vitest";
import { TriagePayloadSchema, validateTriageVerdicts } from "../src/review/triageSchema.js";

describe("triage schema", () => {
  it("accepts one verdict per inventory thread", () => {
    const payload = TriagePayloadSchema.parse({
      verdicts: [
        {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "abcdef1",
          evidence: "guarded null user",
        },
        {
          verdict: "dismissed",
          threadRootCommentId: 2,
          evidence: "maintainer said intentional",
        },
      ],
    });

    expect(
      validateTriageVerdicts({
        payload,
        inventory: [
          { threadRootCommentId: 1, hasHumanReplies: false },
          { threadRootCommentId: 2, hasHumanReplies: true },
        ],
        committedShas: ["abcdef1"],
        commitByThreadRootCommentId: new Map([[1, "abcdef1"]]),
      }),
    ).toEqual([]);
  });

  it("rejects hallucinated ids, unknown commits, missing verdicts, and dismissed without human reply", () => {
    const payload = TriagePayloadSchema.parse({
      verdicts: [
        {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "deadbee",
          evidence: "changed",
        },
        {
          verdict: "dismissed",
          threadRootCommentId: 3,
          evidence: "no reply exists",
        },
      ],
    });

    expect(
      validateTriageVerdicts({
        payload,
        inventory: [
          { threadRootCommentId: 1, hasHumanReplies: false },
          { threadRootCommentId: 2, hasHumanReplies: false },
          { threadRootCommentId: 3, hasHumanReplies: false },
        ],
        committedShas: ["abcdef1"],
        commitByThreadRootCommentId: new Map([[2, "abcdef1"]]),
      }),
    ).toEqual([
      "fixed verdict for 1 references an unknown commit",
      "dismissed verdict for 3 requires human replies",
      "threadRootCommentId 2 is missing a verdict",
      "threadRootCommentId 2 has commit abcdef1 but no fixed verdict",
    ]);
  });
});
