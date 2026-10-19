import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  TriagePayloadSchema,
  validateTriageVerdicts,
  VerificationPayloadSchema,
  validateVerificationVerdicts,
} from "../src/review/triageSchema.ts";

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
          { threadRootCommentId: 1, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 2, hasAuthorizedMaintainerDecision: true },
        ],
        committedShas: ["abcdef1"],
        commitByThreadRootCommentId: new Map([[1, "abcdef1"]]),
      }),
    ).toEqual([]);
  });

  it("rejects hallucinated ids, unknown commits, missing verdicts, and dismissed without authorization", () => {
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
          { threadRootCommentId: 1, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 2, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 3, hasAuthorizedMaintainerDecision: false },
        ],
        committedShas: ["abcdef1"],
        commitByThreadRootCommentId: new Map([[2, "abcdef1"]]),
      }),
    ).toEqual([
      "fixed verdict for 1 references an unknown commit",
      "dismissed verdict for 3 requires an authorized maintainer decision",
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
          { threadRootCommentId: 1, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 2, hasAuthorizedMaintainerDecision: false },
        ],
        pushedShas: ["abcdef1"],
      }),
    ).toEqual([]);
  });

  it("rejects hallucinated ids, unknown commits, missing verdicts, and dismissed without authorization", () => {
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
          { threadRootCommentId: 1, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 2, hasAuthorizedMaintainerDecision: false },
          { threadRootCommentId: 3, hasAuthorizedMaintainerDecision: false },
        ],
        pushedShas: ["abcdef1"],
      }),
    ).toEqual([
      "fixed verdict for 1 references an unknown commit",
      "dismissed verdict for 3 requires an authorized maintainer decision",
      "threadRootCommentId 2 is missing a verdict",
    ]);
  });

  it("rejects objection decisions that disagree with the inventory", () => {
    const candidate = {
      commentId: 50,
      createdAt: "2026-01-01T14:32:47Z",
      updatedAt: "2026-01-01T14:32:47Z",
      authorUserId: 10,
      association: "NONE" as const,
      authorized: false,
      body: "This finding is wrong.",
    };
    const holdOnFixed = v.parse(VerificationPayloadSchema, {
      verdicts: [
        {
          verdict: "fixed",
          threadRootCommentId: 1,
          commitSha: "abcdef1",
          evidence: "guarded",
        },
      ],
      objectionDecisions: [
        {
          decision: "hold",
          commentId: 50,
          updatedAt: candidate.updatedAt,
          body: "The race remains.",
        },
      ],
    });
    expect(
      validateVerificationVerdicts({
        payload: holdOnFixed,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: false,
            objections: [candidate],
          },
        ],
        pushedShas: ["abcdef1"],
      }),
    ).toContain("hold for 50 requires a skipped verdict");

    const unauthorizedDismiss = v.parse(VerificationPayloadSchema, {
      verdicts: [{ verdict: "dismissed", threadRootCommentId: 1, evidence: "intentional" }],
      objectionDecisions: [
        {
          decision: "concede",
          commentId: 50,
          updatedAt: candidate.updatedAt,
          body: "Agreed, this is intentional.",
        },
      ],
    });
    expect(
      validateVerificationVerdicts({
        payload: unauthorizedDismiss,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: true,
            objections: [candidate],
          },
        ],
        pushedShas: [],
      }),
    ).toContain(
      "concede for 50 cannot dismiss without that candidate's authorized maintainer decision",
    );

    const stale = v.parse(VerificationPayloadSchema, {
      verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }],
      objectionDecisions: [
        {
          decision: "hold",
          commentId: 50,
          updatedAt: "2026-01-01T16:00:00Z",
          body: "Still open.",
        },
      ],
    });
    expect(
      validateVerificationVerdicts({
        payload: stale,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: false,
            objections: [candidate],
          },
        ],
        pushedShas: [],
      }),
    ).toContain("objection 50 updatedAt does not match the candidate");

    const duplicate = v.parse(VerificationPayloadSchema, {
      verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }],
      objectionDecisions: [
        {
          decision: "hold",
          commentId: 50,
          updatedAt: candidate.updatedAt,
          body: "First.",
        },
        {
          decision: "not_objection",
          commentId: 50,
          updatedAt: candidate.updatedAt,
          reason: "Second.",
        },
      ],
    });
    expect(
      validateVerificationVerdicts({
        payload: duplicate,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: false,
            objections: [candidate],
          },
        ],
        pushedShas: [],
      }),
    ).toContain("objection 50 has more than one decision");

    const missing = v.parse(VerificationPayloadSchema, {
      verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }],
    });
    expect(
      validateVerificationVerdicts({
        payload: missing,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: false,
            objections: [candidate],
          },
        ],
        pushedShas: [],
      }),
    ).toContain("objection 50 is missing a decision");

    const unknown = v.parse(VerificationPayloadSchema, {
      verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }],
      objectionDecisions: [
        {
          decision: "hold",
          commentId: 99,
          updatedAt: candidate.updatedAt,
          body: "Unknown thread.",
        },
        {
          decision: "hold",
          commentId: 50,
          updatedAt: candidate.updatedAt,
          body: "Known thread.",
        },
      ],
    });
    expect(
      validateVerificationVerdicts({
        payload: unknown,
        inventory: [
          {
            threadRootCommentId: 1,
            hasAuthorizedMaintainerDecision: false,
            objections: [candidate],
          },
        ],
        pushedShas: [],
      }),
    ).toContain("objection 99 is not in the verification inventory");
  });

  it("drops objection decisions when a triage payload is parsed", () => {
    const parsed = v.parse(TriagePayloadSchema, {
      verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "still open" }],
      objectionDecisions: [
        {
          decision: "hold",
          commentId: 50,
          updatedAt: "2026-01-01T14:32:47Z",
          body: "Still open.",
        },
      ],
    });
    expect(parsed).not.toHaveProperty("objectionDecisions");
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
        inventory: [{ threadRootCommentId: 1, hasAuthorizedMaintainerDecision: false }],
        pushedShas: ["abcdef1234567890abcdef1234567890abcdef12"],
      }),
    ).toEqual([]);
  });
});
