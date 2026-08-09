import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  TriagePayloadSchema,
  validateTriageVerdicts,
  VerificationPayloadSchema,
  validateVerificationVerdicts,
} from "../src/review/triageSchema.js";

describe("triage schema", () => {
  it("accepts one verdict per inventory thread", () => {
    const payload = v.parse(TriagePayloadSchema, {
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
    const payload = v.parse(TriagePayloadSchema, {
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

describe("verification schema", () => {
  it("accepts one verdict per inventory thread with pushed shas", () => {
    const payload = v.parse(VerificationPayloadSchema, {
      verdicts: [
        {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "abcdef1",
          evidence: "user fixed it",
        },
        {
          verdict: "skipped",
          threadRootCommentId: 2,
          reason: "still open",
        },
      ],
    });

    expect(
      validateVerificationVerdicts({
        payload,
        inventory: [
          { threadRootCommentId: 1, hasHumanReplies: false },
          { threadRootCommentId: 2, hasHumanReplies: false },
        ],
        pushedShas: ["abcdef1"],
      }),
    ).toEqual([]);
  });

  it("rejects hallucinated ids, unknown commits, missing verdicts, and dismissed without human reply", () => {
    const payload = v.parse(VerificationPayloadSchema, {
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
      validateVerificationVerdicts({
        payload,
        inventory: [
          { threadRootCommentId: 1, hasHumanReplies: false },
          { threadRootCommentId: 2, hasHumanReplies: false },
          { threadRootCommentId: 3, hasHumanReplies: false },
        ],
        pushedShas: ["abcdef1"],
      }),
    ).toEqual([
      "fixed verdict for 1 references an unknown commit",
      "dismissed verdict for 3 requires human replies",
      "threadRootCommentId 2 is missing a verdict",
    ]);
  });

  it("matches short SHA prefix against full SHA from API", () => {
    const payload = v.parse(VerificationPayloadSchema, {
      verdicts: [
        {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "abcdef1",
          evidence: "user fixed it",
        },
      ],
    });

    expect(
      validateVerificationVerdicts({
        payload,
        inventory: [{ threadRootCommentId: 1, hasHumanReplies: false }],
        pushedShas: ["abcdef1234567890abcdef1234567890abcdef12"],
      }),
    ).toEqual([]);
  });
});
