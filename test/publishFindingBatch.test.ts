import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  deterministicInlineBatchId,
  reviewInlineBatchOperationKey,
} from "../src/agentWork/withOperationIntent.js";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
  type FindingLedger,
} from "../src/review/orchestrator/orchestratorTypes.js";
import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { REVIEW_POINTER_BODY } from "../src/settings/index.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import {
  createTestEvidenceLedger,
  seedEvidenceForFindings,
} from "./helpers/evidenceTestHelpers.js";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";

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

const PROGRESS_COMMENT_URL = "https://github.com/o/r/pull/1#issuecomment-99";

function batchContext(
  ledger: FindingLedger,
  recordPublishStep = vi.fn(async () => undefined),
  overrides: Partial<Parameters<typeof publishFindingBatch>[1]> & {
    readonly seedFindings?: readonly ReviewFinding[];
  } = {},
): Parameters<typeof publishFindingBatch>[1] {
  const { seedFindings, ...restOverrides } = overrides;
  const evidenceLedger = restOverrides.evidenceLedger ?? createTestEvidenceLedger("abc1234");
  if (restOverrides.evidenceLedger == null) {
    seedEvidenceForFindings(evidenceLedger, seedFindings ?? [finding]);
  }
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
    progressCommentUrl: PROGRESS_COMMENT_URL,
    getToken: () => "token",
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10]),
    recordPublishStep,
    ledger,
    evidenceLedger,
    ...restOverrides,
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
        seedFindings: findings,
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

  it("publishes Note + specialist tagline linked to the progress stub", async () => {
    const result = await publishFindingBatch(
      [finding],
      batchContext(createFindingLedger(), undefined, { source: "security" }),
    );

    expect(result.kind).toBe("published");
    const reviewParams = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(reviewParams?.body).toContain(
      `Track this run on the [progress stub](${PROGRESS_COMMENT_URL}) in the PR conversation.`,
    );
    expect(reviewParams?.body).toContain("Here's what the security found.");
    expect(reviewParams?.body).not.toContain(REVIEW_POINTER_BODY);
    expect(reviewParams?.body).not.toContain("Fix all findings (agent prompt)");
  });

  it("fails clearly when the progress comment URL is missing", async () => {
    await expect(
      publishFindingBatch(
        [finding],
        batchContext(createFindingLedger(), undefined, { progressCommentUrl: undefined }),
      ),
    ).rejects.toThrow(/progress comment/i);
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
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

  it("propagates abort-check failures so the durable job can retry", async () => {
    const abortCheckError = new Error("temporary head lookup failure");

    await expect(
      publishFindingBatch(
        [finding],
        batchContext(createFindingLedger(), undefined, {
          shouldAbortPublish: async () => {
            throw abortCheckError;
          },
        }),
      ),
    ).rejects.toBe(abortCheckError);
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
        seedFindings: [findingAt(10)],
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
        seedFindings: [ninthFinding],
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

  it("uses a stable batch id and operation key across retries", async () => {
    const pool = {} as Pool;
    const fingerprint = fingerprintFinding(finding, "review");
    const expectedBatchId = deterministicInlineBatchId({
      workItemId: "wi-1",
      specialist: "correctness",
      findingFingerprints: [fingerprint],
    });
    const expectedKey = reviewInlineBatchOperationKey(expectedBatchId);
    const recordPublishStep = vi.fn(async () => undefined);

    const first = await publishFindingBatch(
      [finding],
      batchContext(createFindingLedger(), recordPublishStep, {
        operationIntent: { client: pool, workItemId: "wi-1", resourceKey: "o/r#1" },
      }),
    );
    expect(first.kind).toBe("published");
    expect(recordPublishStep).toHaveBeenCalledWith(
      "inline_review",
      expect.objectContaining({
        meta: expect.objectContaining({ batchId: expectedBatchId }),
      }),
    );
    expect(memoryOperationIntentStore.get("wi-1", expectedKey)?.status).toBe("reconciled");

    vi.mocked(createPullRequestReviewWithComments).mockClear();
    const second = await publishFindingBatch(
      [finding],
      batchContext(createFindingLedger(), recordPublishStep, {
        operationIntent: { client: pool, workItemId: "wi-1", resourceKey: "o/r#1" },
      }),
    );
    expect(second.kind).toBe("published");
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(memoryOperationIntentStore.get("wi-1", expectedKey)?.status).toBe("reconciled");
  });

  it("does not remutate after crash between GitHub accept and reconcile", async () => {
    const pool = {} as Pool;
    const fingerprint = fingerprintFinding(finding, "review");
    const batchId = deterministicInlineBatchId({
      workItemId: "wi-crash",
      specialist: "correctness",
      findingFingerprints: [fingerprint],
    });
    const operationKey = reviewInlineBatchOperationKey(batchId);
    memoryOperationIntentStore.failNextReconcile(new Error("crash before reconcile"), 2);

    await expect(
      publishFindingBatch(
        [finding],
        batchContext(
          createFindingLedger(),
          vi.fn(async () => undefined),
          {
            workItemId: "wi-crash",
            operationIntent: { client: pool, workItemId: "wi-crash", resourceKey: "o/r#1" },
          },
        ),
      ),
    ).rejects.toThrow("crash before reconcile");

    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    const pending = memoryOperationIntentStore.get("wi-crash", operationKey);
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual(
      expect.objectContaining({
        review: expect.objectContaining({ id: 101 }),
      }),
    );

    vi.mocked(createPullRequestReviewWithComments).mockClear();
    const recovered = await publishFindingBatch(
      [finding],
      batchContext(
        createFindingLedger(),
        vi.fn(async () => undefined),
        {
          workItemId: "wi-crash",
          operationIntent: { client: pool, workItemId: "wi-crash", resourceKey: "o/r#1" },
        },
      ),
    );

    expect(recovered.kind).toBe("published");
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(memoryOperationIntentStore.get("wi-crash", operationKey)?.status).toBe("reconciled");
  });
});
