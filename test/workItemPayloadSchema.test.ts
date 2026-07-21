import { describe, expect, it } from "vitest";
import {
  attachWorkItemPayload,
  parseWorkItemPayload,
  WorkItemPayloadValidationError,
} from "../src/agentWork/workItemPayloadSchema.js";
import type { AgentWorkItemCore, WorkType } from "../src/agentWork/types.js";
import { AppError } from "../src/errors/appError.js";
import {
  makeAskWorkItem,
  makeDescriptionWorkItem,
  makeReviewWorkItem,
  makeTriageWorkItem,
  makeVerificationWorkItem,
} from "./helpers/agentWorkItems.js";
import { coreOf } from "./helpers/executorDurableHarness.js";

describe("WorkItemPayloadValidationError", () => {
  it("extends AppError with code and workType", () => {
    const err = new WorkItemPayloadValidationError("review", "bad payload");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(WorkItemPayloadValidationError);
    expect(err.code).toBe("agent_work.invalid_payload");
    expect(err.workType).toBe("review");
    expect(err.message).toBe("bad payload");
  });
});

const validByType = {
  review: () => makeReviewWorkItem().payload,
  ask: () => makeAskWorkItem().payload,
  description: () => makeDescriptionWorkItem().payload,
  triage: () => makeTriageWorkItem().payload,
  verification: () => makeVerificationWorkItem().payload,
} as const satisfies Record<WorkType, () => unknown>;

describe("parseWorkItemPayload", () => {
  it("accepts a valid payload for each work item type", () => {
    for (const type of Object.keys(validByType) as WorkType[]) {
      expect(parseWorkItemPayload(type, validByType[type]())).toEqual(validByType[type]());
    }
  });

  it("accepts optional pushBeforeSha on verification payloads", () => {
    const pushBeforeSha = "f".repeat(40);
    expect(
      parseWorkItemPayload("verification", {
        source: "auto",
        pushBeforeSha,
      }),
    ).toEqual({ source: "auto", pushBeforeSha });
  });

  it("rejects cross-type payloads", () => {
    expect(() => parseWorkItemPayload("review", validByType.ask())).toThrow(
      WorkItemPayloadValidationError,
    );
    expect(() => parseWorkItemPayload("ask", validByType.review())).toThrow(
      WorkItemPayloadValidationError,
    );
    expect(() => parseWorkItemPayload("triage", validByType.verification())).toThrow(
      WorkItemPayloadValidationError,
    );
    expect(() => parseWorkItemPayload("verification", validByType.triage())).toThrow(
      WorkItemPayloadValidationError,
    );
  });

  it("rejects malformed nested ReplyTarget and CodeAnchor fields", () => {
    expect(() =>
      parseWorkItemPayload("ask", {
        question: "q",
        commentId: 1,
        replyTarget: { kind: "prConversation" },
      }),
    ).toThrow(/replyTarget/);

    expect(() =>
      parseWorkItemPayload("ask", {
        question: "q",
        commentId: 1,
        replyTarget: { kind: "inlineReviewThread", prNumber: 1 },
      }),
    ).toThrow(/inReplyToCommentId/);

    expect(() =>
      parseWorkItemPayload("ask", {
        question: "q",
        commentId: 1,
        replyTarget: { kind: "prConversation", prNumber: 1 },
        codeAnchor: { path: "a.ts" },
      }),
    ).toThrow(/line/);
  });

  it("preserves unknown legacy JSON keys", () => {
    const parsed = parseWorkItemPayload("review", {
      mode: "review",
      source: "auto",
      legacyMarker: "keep-me",
      nestedLegacy: { ok: true },
    });
    expect(parsed).toMatchObject({
      mode: "review",
      source: "auto",
      legacyMarker: "keep-me",
      nestedLegacy: { ok: true },
    });
  });

  it.each(["review-security", "review-quality", "review-tests"] as const)(
    "normalizes stored legacy mode %s to review",
    (mode) => {
      expect(
        parseWorkItemPayload("review", {
          mode,
          source: "auto",
        }),
      ).toEqual({
        mode: "review",
        source: "auto",
      });
    },
  );

  it.each([
    { type: "review" as const, missing: "mode", payload: { source: "auto" } },
    { type: "review" as const, missing: "source", payload: { mode: "review" } },
    {
      type: "ask" as const,
      missing: "question",
      payload: { commentId: 1, replyTarget: { kind: "prConversation", prNumber: 1 } },
    },
    {
      type: "ask" as const,
      missing: "commentId",
      payload: { question: "q", replyTarget: { kind: "prConversation", prNumber: 1 } },
    },
    {
      type: "ask" as const,
      missing: "replyTarget",
      payload: { question: "q", commentId: 1 },
    },
    { type: "description" as const, missing: "source", payload: {} },
    {
      type: "triage" as const,
      missing: "source",
      payload: {
        commentId: 1,
        scope: "all",
        replyTarget: { kind: "prConversation", prNumber: 1 },
      },
    },
    {
      type: "triage" as const,
      missing: "commentId",
      payload: {
        source: "slash",
        scope: "all",
        replyTarget: { kind: "prConversation", prNumber: 1 },
      },
    },
    {
      type: "triage" as const,
      missing: "scope",
      payload: {
        source: "slash",
        commentId: 1,
        replyTarget: { kind: "prConversation", prNumber: 1 },
      },
    },
    {
      type: "triage" as const,
      missing: "replyTarget",
      payload: { source: "slash", commentId: 1, scope: "all" },
    },
    { type: "verification" as const, missing: "source", payload: {} },
  ])("rejects $type payload missing required $missing", ({ type, payload }) => {
    expect(() => parseWorkItemPayload(type, payload)).toThrow(WorkItemPayloadValidationError);
  });
});

describe("attachWorkItemPayload", () => {
  it("recombines a typed core with a validated payload", () => {
    const item = makeAskWorkItem({
      payload: {
        question: "why?",
        codeAnchor: { path: "f.ts", line: 3, side: "RIGHT" },
      },
    });
    const core = coreOf(item);
    const attached = attachWorkItemPayload(core, item.payload);
    expect(attached.type).toBe("ask");
    if (attached.type !== "ask") throw new Error("expected ask");
    expect(attached.payload.question).toBe("why?");
    expect(attached.payload.codeAnchor).toEqual({ path: "f.ts", line: 3, side: "RIGHT" });
  });

  it("rejects payload that does not match the core type", () => {
    const core: AgentWorkItemCore = coreOf(makeReviewWorkItem());
    expect(() => attachWorkItemPayload(core, validByType.ask())).toThrow(
      WorkItemPayloadValidationError,
    );
  });
});
