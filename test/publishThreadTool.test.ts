import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import {
  createOrchestratorPhaseRef,
  WRONG_PHASE_TOOL_CODE,
} from "../src/review/orchestrator/phaseToolPolicy.js";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import type { PrSurface } from "../src/github/prSurface.js";

const settingsOverrides = vi.hoisted((): { maxThreadPublishCalls: number | undefined } => ({
  maxThreadPublishCalls: undefined,
}));

vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get MAX_THREAD_PUBLISH_CALLS() {
      return settingsOverrides.maxThreadPublishCalls ?? actual.MAX_THREAD_PUBLISH_CALLS;
    },
  };
});

let nextReviewId = 100;

function finding(line: number): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The changed path at line ${line} returns the wrong value.`,
    fixPrompt: `Correct the path at line ${line}.`,
  };
}

function buildTool(
  shouldAbortPublish?: () => Promise<boolean>,
  publishImpl?: PrSurface["publishThreadBatch"],
) {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch").mockImplementation(
    publishImpl ??
      (async () => {
        nextReviewId += 1;
        return { reviewId: nextReviewId, reviewUrl: `https://example.com/reviews/${nextReviewId}` };
      }),
  );
  const tool = buildPublishThreadTool({
    phaseRef: createOrchestratorPhaseRef("judgment"),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionReviewMap: false,
    },
    workItemId: "wi-1",
    resolveProgressCommentUrl: async () => "https://github.com/o/r/pull/1#issuecomment-99",
    prSurface: surface,
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
    recordPublishStep: vi.fn(async () => undefined),
    shouldAbortPublish,
    initialLedger: createFindingLedger(),
  });
  return { tool, publishThreadBatch };
}

describe("buildPublishThreadTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextReviewId = 100;
    settingsOverrides.maxThreadPublishCalls = undefined;
  });

  it("carries the finding ledger across calls and reports same-file published threads", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");

    const first = await tool.executor({ findings: [finding(10)] });
    tool.setSource("security");
    const second = await tool.executor({ findings: [finding(10), finding(20)] });

    expect(tool.piTool.name).toBe("publish_thread");
    expect(first).toMatchObject({
      kind: "published",
      publishedThreadOverlapHints: [
        expect.objectContaining({
          file: "src/a.ts",
          startLine: 10,
          title: "Bug at line 10",
        }),
      ],
    });
    expect(second).toMatchObject({
      kind: "published",
      publishedThreadOverlapHints: [
        expect.objectContaining({ startLine: 10 }),
        expect.objectContaining({ startLine: 20 }),
      ],
    });
    expect(publishThreadBatch).toHaveBeenCalledTimes(2);
    expect(tool.getLedger().accepted).toHaveLength(2);
    expect(tool.getLedger().accepted.map((placement) => placement.source)).toEqual([
      "correctness",
      "security",
    ]);
    expect(tool.getLedger().postedInlineCount).toBe(2);
    expect(tool.getLedger().threadCallCount).toBe(2);
    expect(tool.getPublishedBatchCount()).toBe(2);
  });

  it("retains budget-exhausted findings as summary-only ledger entries", async () => {
    settingsOverrides.maxThreadPublishCalls = 1;
    const { tool } = buildTool();
    tool.setSource("security");

    await tool.executor({ findings: [finding(10)] });
    const result = await tool.executor({ findings: [finding(20)] });

    expect(result.kind).toBe("budget_exhausted");
    expect(tool.getLedger().accepted).toEqual([
      expect.objectContaining({ kind: "posted", source: "security" }),
      expect.objectContaining({
        kind: "summary_only",
        source: "security",
        reason: "budget",
      }),
    ]);
    expect(tool.getLedger().threadBudgetExhausted).toBe(true);
    expect(tool.getPublishedBatchCount()).toBe(1);
  });

  it("repairs a single-object findings payload at the parse seam", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");

    const result = await tool.executor({ findings: finding(10) });

    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().accepted).toHaveLength(1);
  });

  it("rejects malformed calls and calls made before a specialist source is selected", async () => {
    const { tool, publishThreadBatch } = buildTool();

    await expect(tool.executor({ findings: "not-an-array" })).rejects.toMatchObject({
      code: "review.publish_thread_validation_failed",
    });
    await expect(tool.executor({ findings: [finding(10)] })).rejects.toMatchObject({
      code: "review.publish_thread_source_required",
    });
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(tool.getPublishedBatchCount()).toBe(0);
    expect(publishThreadBatch).not.toHaveBeenCalled();
  });

  it("rejects wrong-phase calls before publish with a structured shape", async () => {
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const tool = buildPublishThreadTool({
      phaseRef: createOrchestratorPhaseRef("recon"),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "abc1234",
        hasDescriptionReviewMap: false,
      },
      workItemId: "wi-1",
      resolveProgressCommentUrl: async () => "https://github.com/o/r/pull/1#issuecomment-99",
      prSurface: surface,
      cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
      recordPublishStep: vi.fn(async () => undefined),
      initialLedger: createFindingLedger(),
    });

    const result = await tool.executor({});

    expect(result).toEqual({
      kind: "wrong_phase",
      code: WRONG_PHASE_TOOL_CODE,
      phase: "recon",
      allowed: ["submit_specialist_brief"],
      error: expect.stringContaining("publish_thread"),
    });
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(publishThreadBatch).not.toHaveBeenCalled();
  });

  it("leaves the ledger unchanged when the publish gate stops the call", async () => {
    const { tool, publishThreadBatch } = buildTool(async () => true);
    tool.setSource("tests");

    const result = await tool.executor({ findings: [finding(10)] });

    expect(result.kind).toBe("stopped");
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(publishThreadBatch).not.toHaveBeenCalled();
  });

  it("leaves the ledger unchanged when GitHub publish throws", async () => {
    const { tool, publishThreadBatch } = buildTool(undefined, async () => {
      throw new Error("GitHub unavailable");
    });
    tool.setSource("quality");

    await expect(tool.executor({ findings: [finding(10)] })).rejects.toMatchObject({
      code: "review.publish_thread_failed",
    });

    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(tool.getPublishedBatchCount()).toBe(0);
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
  });
});
