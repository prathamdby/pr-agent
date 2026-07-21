import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
  type FindingLedger,
} from "../src/review/orchestrator/orchestratorTypes.js";
import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";

const settingsOverrides = vi.hoisted(
  (): {
    maxInlineReviewComments: number | undefined;
    maxThreadPublishCalls: number | undefined;
  } => ({
    maxInlineReviewComments: undefined,
    maxThreadPublishCalls: undefined,
  }),
);

vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get MAX_INLINE_REVIEW_COMMENTS() {
      return settingsOverrides.maxInlineReviewComments ?? actual.MAX_INLINE_REVIEW_COMMENTS;
    },
    get MAX_THREAD_PUBLISH_CALLS() {
      return settingsOverrides.maxThreadPublishCalls ?? actual.MAX_THREAD_PUBLISH_CALLS;
    },
  };
});

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    createPullRequestReviewWithComments: vi.fn(async () => ({
      id: 101,
      url: "https://example.com/reviews/101",
    })),
  };
});

import { createPullRequestReviewWithComments } from "../src/github/reviewPublish.js";

const finding: ReviewFinding = {
  severity: "P1",
  file: "src/a.ts",
  startLine: 10,
  endLine: 10,
  title: "Missing null check",
  detail: "The payload can be null on this path.",
  fixPrompt: "Guard the payload before dereferencing it.",
};

function findingAt(line: number): ReviewFinding {
  return {
    ...finding,
    startLine: line,
    endLine: line,
    title: `Finding at line ${line}`,
    detail: `The code at line ${line} fails for the covered input.`,
  };
}

function batchContext(
  ledger: FindingLedger,
  recordPublishStep = vi.fn(async () => undefined),
  overrides: Partial<Parameters<typeof publishFindingBatch>[1]> = {},
): Parameters<typeof publishFindingBatch>[1] {
  return {
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionAgentBlock: false,
    },
    source: "correctness",
    workItemId: "wi-1",
    getToken: () => "token",
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10]),
    recordPublishStep,
    ledger,
    ...overrides,
  };
}

describe("publishFindingBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsOverrides.maxInlineReviewComments = undefined;
    settingsOverrides.maxThreadPublishCalls = undefined;
  });

  it("does not create a GitHub review when suppression empties the batch", async () => {
    const recordPublishStep = vi.fn(async () => undefined);
    const result = await publishFindingBatch(
      [finding],
      batchContext(
        createFindingLedger({
          suppressionFingerprints: [fingerprintFinding(finding, "review")],
        }),
        recordPublishStep,
      ),
    );

    expect(result.kind).toBe("empty");
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
    if (result.kind !== "empty") return;
    expect(result.delta.accepted).toEqual([
      expect.objectContaining({ kind: "summary_only", reason: "historical" }),
    ]);
    expect(result.delta.threadCallCount).toBe(1);
  });

  it("suppresses a finding already posted by an earlier batch", async () => {
    const recordPublishStep = vi.fn(async () => undefined);
    const initialLedger = createFindingLedger();
    const first = await publishFindingBatch(
      [finding],
      batchContext(initialLedger, recordPublishStep),
    );
    expect(first.kind).toBe("published");
    if (first.kind !== "published") return;
    expect(initialLedger.postedInlineCount).toBe(0);
    expect(recordPublishStep).toHaveBeenCalledWith(
      "inline_review",
      expect.objectContaining({
        githubId: 101,
        meta: expect.objectContaining({
          version: 2,
          workItemId: "wi-1",
          specialist: "correctness",
          reviewId: 101,
          event: "COMMENT",
          placements: [
            expect.objectContaining({
              finding,
              resolvedLine: 10,
              canonicalFingerprint: fingerprintFinding(finding, "review"),
            }),
          ],
        }),
      }),
    );
    const ledger = applyFindingLedgerDelta(createFindingLedger(), first.delta);

    const second = await publishFindingBatch([finding], batchContext(ledger, recordPublishStep));

    expect(second.kind).toBe("empty");
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    expect(recordPublishStep).toHaveBeenCalledTimes(1);
    if (second.kind !== "empty") return;
    expect(second.delta.accepted).toEqual([]);
  });

  it("applies the remaining global inline cap", async () => {
    settingsOverrides.maxInlineReviewComments = 3;
    const findings = [findingAt(10), findingAt(20), findingAt(30), findingAt(40)];
    const result = await publishFindingBatch(
      findings,
      batchContext(createFindingLedger({ postedInlineCount: 2 }), undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20, 30, 40]),
      }),
    );

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    const reviewParams = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(reviewParams?.event).toBe("COMMENT");
    expect(reviewParams?.comments).toHaveLength(1);
    expect(result.delta.postedInlineCount).toBe(1);
    expect(result.delta.accepted).toHaveLength(4);
    expect(
      result.delta.accepted.filter(
        (placement) => placement.kind === "summary_only" && placement.reason === "cap",
      ),
    ).toHaveLength(3);
  });

  it("stops before the GitHub write when the run was superseded", async () => {
    const result = await publishFindingBatch(
      [finding],
      batchContext(createFindingLedger(), undefined, {
        shouldAbortPublish: async () => true,
      }),
    );

    expect(result).toEqual({ kind: "stopped", reason: "superseded" });
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("reports a stale head when the publish gate records one", async () => {
    const result = await publishFindingBatch(
      [finding],
      batchContext(createFindingLedger(), undefined, {
        shouldAbortPublish: async () => true,
        publishAbortState: { staleHead: true },
      }),
    );

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("propagates arbitrary GitHub publish failures", async () => {
    vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );
    const recordPublishStep = vi.fn(async () => undefined);

    await expect(
      publishFindingBatch([finding], batchContext(createFindingLedger(), recordPublishStep)),
    ).rejects.toThrow("GitHub unavailable");
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("downgrades later calls to summary-only after the thread budget", async () => {
    settingsOverrides.maxThreadPublishCalls = 1;
    const result = await publishFindingBatch(
      [finding],
      batchContext(
        createFindingLedger({
          threadCallCount: 1,
        }),
      ),
    );

    expect(result.kind).toBe("budget_exhausted");
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    if (result.kind !== "budget_exhausted") return;
    expect(result.delta.threadBudgetExhausted).toBe(true);
    expect(result.delta.accepted).toEqual([
      expect.objectContaining({ kind: "summary_only", reason: "budget" }),
    ]);
  });

  it("allows the eighth thread call and downgrades the ninth without losing findings", async () => {
    const ledgerBeforeEighth = createFindingLedger({ threadCallCount: 7 });
    const eighth = await publishFindingBatch(
      [findingAt(10)],
      batchContext(ledgerBeforeEighth, undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
      }),
    );

    expect(eighth.kind).toBe("published");
    if (eighth.kind !== "published") return;
    expect(ledgerBeforeEighth.threadCallCount).toBe(7);
    const ledgerAfterEighth = applyFindingLedgerDelta(ledgerBeforeEighth, eighth.delta);
    const ninthFinding = findingAt(20);
    const ninth = await publishFindingBatch(
      [ninthFinding],
      batchContext(ledgerAfterEighth, undefined, {
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
      }),
    );

    expect(ledgerAfterEighth.threadCallCount).toBe(8);
    expect(ninth.kind).toBe("budget_exhausted");
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    if (ninth.kind !== "budget_exhausted") return;
    expect(ninth.delta.accepted).toEqual([
      expect.objectContaining({
        kind: "summary_only",
        reason: "budget",
        placement: expect.objectContaining({ finding: ninthFinding }),
      }),
    ]);
  });
});
