import { describe, expect, it } from "vitest";
import {
  countOpenFindingSeverities,
  evaluateMergeLoop,
  mergeLoopNextActionForSummary,
  renderMergeLoopComment,
  reviewStateFromProgressComment,
} from "../src/review/loop.js";
import {
  LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
  REVIEW_LOOP_LEAD,
  REVIEW_LOOP_NEXT_FIX_CI,
  REVIEW_LOOP_NEXT_HUMAN,
  REVIEW_LOOP_NEXT_LIGHTWEIGHT,
  REVIEW_LOOP_NEXT_RUN_REVIEW,
  REVIEW_LOOP_NEXT_STALE_REVIEW,
  REVIEW_LOOP_NEXT_TRIAGE_BLOCKING,
  REVIEW_LOOP_NEXT_TRIAGE_OPTIONAL,
  REVIEW_LOOP_NEXT_WAIT_CI,
  REVIEW_LOOP_NEXT_WAIT_REVIEW,
  REVIEW_LOOP_SENTINEL,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_QUEUED_NOTE,
} from "../src/settings/index.js";
import { renderStaleReviewMetadataComment } from "../src/review/run/reviewRender.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { ListReviewThreadResolutionResult } from "../src/github/reviewThreadResolution.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function thread(
  overrides: Partial<BotFindingThread> & Pick<BotFindingThread, "rootCommentId" | "severity">,
): BotFindingThread {
  return {
    lens: "review",
    path: "src/a.ts",
    line: 1,
    titleSnippet: "Bug",
    humanReplies: [],
    threadUrl: "https://example.test/1",
    ...overrides,
  };
}

function resolution(
  entries: ReadonlyArray<readonly [number, boolean]>,
  status: ListReviewThreadResolutionResult["status"] = "ok",
): ListReviewThreadResolutionResult {
  return {
    status,
    byRootCommentId: new Map(
      entries.map(([id, isResolved]) => [id, { threadNodeId: `t${id}`, isResolved }]),
    ),
  };
}

describe("reviewStateFromProgressComment", () => {
  it("returns none when there is no comment", () => {
    expect(reviewStateFromProgressComment(null, HEAD)).toEqual({ kind: "none" });
  });

  it("returns in_progress for queued and running stubs", () => {
    expect(reviewStateFromProgressComment(REVIEW_PROGRESS_QUEUED_NOTE, HEAD).kind).toBe(
      "in_progress",
    );
    expect(reviewStateFromProgressComment(REVIEW_PROGRESS_NOTE, HEAD).kind).toBe("in_progress");
  });

  it("returns complete when metadata matches the current head", () => {
    const body = [
      "## PR Agent Review",
      renderStaleReviewMetadataComment({ headSha: HEAD, mode: "review", stale: false }),
    ].join("\n");
    expect(reviewStateFromProgressComment(body, HEAD)).toEqual({
      kind: "complete",
      headSha: HEAD,
      current: true,
    });
  });

  it("returns lightweight when the docs-only lead is present", () => {
    const body = [
      LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
      renderStaleReviewMetadataComment({ headSha: HEAD, mode: "review", stale: false }),
    ].join("\n");
    expect(reviewStateFromProgressComment(body, HEAD)).toEqual({
      kind: "lightweight",
      headSha: HEAD,
      current: true,
    });
  });

  it("treats a merged cancel notice as none", () => {
    expect(reviewStateFromProgressComment("PR merged.", HEAD)).toEqual({ kind: "none" });
  });
});

describe("countOpenFindingSeverities", () => {
  it("skips resolved threads when resolution status is ok", () => {
    const counts = countOpenFindingSeverities(
      [
        thread({ rootCommentId: 1, severity: "P0" }),
        thread({ rootCommentId: 2, severity: "P2" }),
        thread({ rootCommentId: 3, severity: "P1" }),
      ],
      resolution([
        [1, true],
        [2, false],
        [3, false],
      ]),
    );
    expect(counts).toEqual({ openP0P1: 1, openP2P3: 1 });
  });

  it("counts every thread when resolution is unavailable", () => {
    const counts = countOpenFindingSeverities(
      [thread({ rootCommentId: 1, severity: "P0" }), thread({ rootCommentId: 2, severity: "P3" })],
      { status: "unavailable", byRootCommentId: new Map() },
    );
    expect(counts).toEqual({ openP0P1: 1, openP2P3: 1 });
  });
});

describe("evaluateMergeLoop", () => {
  it("asks for /review when no review exists", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "none" },
      openP0P1: 0,
      openP2P3: 0,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_RUN_REVIEW);
  });

  it("waits when a review is in progress", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "in_progress" },
      openP0P1: 2,
      openP2P3: 0,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_WAIT_REVIEW);
  });

  it("routes P0/P1 to triage and never claims merge", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: HEAD, current: true },
      openP0P1: 1,
      openP2P3: 0,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_TRIAGE_BLOCKING);
    expect(briefing.nextAction.toLowerCase()).not.toContain("approve");
    expect(briefing.nextAction.toLowerCase()).not.toContain("safe to merge");
  });

  it("keeps optional triage for P2/P3 only", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: HEAD, current: true },
      openP0P1: 0,
      openP2P3: 2,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_TRIAGE_OPTIONAL);
  });

  it("surfaces failing CI before optional P2/P3", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: HEAD, current: true },
      openP0P1: 0,
      openP2P3: 2,
      ciStatus: "failing",
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_FIX_CI);
  });

  it("waits on pending CI when findings are clear", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: HEAD, current: true },
      openP0P1: 0,
      openP2P3: 0,
      ciStatus: "pending",
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_WAIT_CI);
  });

  it("leaves merge to a human when the current head is clean", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: HEAD, current: true },
      openP0P1: 0,
      openP2P3: 0,
      ciStatus: "passing",
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_HUMAN);
  });

  it("requires a new review when the published head is stale", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "complete", headSha: OTHER, current: false },
      openP0P1: 0,
      openP2P3: 0,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_STALE_REVIEW);
  });

  it("keeps the docs-only skip next step on a current lightweight review", () => {
    const briefing = evaluateMergeLoop({
      review: { kind: "lightweight", headSha: HEAD, current: true },
      openP0P1: 0,
      openP2P3: 0,
    });
    expect(briefing.nextAction).toBe(REVIEW_LOOP_NEXT_LIGHTWEIGHT);
  });
});

describe("renderMergeLoopComment", () => {
  it("renders a derived checklist, not a verdict", () => {
    const body = renderMergeLoopComment(
      evaluateMergeLoop({
        review: { kind: "complete", headSha: HEAD, current: true },
        openP0P1: 0,
        openP2P3: 0,
      }),
    );
    expect(body).toContain(REVIEW_LOOP_SENTINEL);
    expect(body).toContain(REVIEW_LOOP_LEAD);
    expect(body).toContain(REVIEW_LOOP_NEXT_HUMAN);
    expect(body.toLowerCase()).not.toContain("safe to merge");
    expect(body.toLowerCase()).not.toContain("approved");
  });
});

describe("mergeLoopNextActionForSummary", () => {
  it("uses this run's findings on the reviewed head", () => {
    expect(
      mergeLoopNextActionForSummary({
        findings: [
          {
            severity: "P1",
            file: "a.ts",
            startLine: 1,
            endLine: 1,
            title: "Bug",
            detail: "Bad.",
            fixPrompt: "Fix.",
          },
        ],
        headSha: HEAD,
      }),
    ).toBe(REVIEW_LOOP_NEXT_TRIAGE_BLOCKING);
  });
});
