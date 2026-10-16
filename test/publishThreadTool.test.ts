import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import {
  createOrchestratorPhaseRef,
  WRONG_PHASE_TOOL_CODE,
} from "../src/review/orchestrator/phaseToolPolicy.js";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.js";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import type { PrSurface } from "../src/github/prSurface.js";
import { buildFindingInventory } from "../src/review/findingIdentity/findingInventory.js";

const emptyInventory = buildFindingInventory({
  threads: { status: "ok", threads: [] },
  summary: null,
  summaryComplete: true,
  botLogin: "pr-agent[bot]",
  renames: new Map(),
  deletedPaths: new Set(),
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

function threadSession(
  surface: PrSurface,
  shouldAbortPublish?: () => Promise<boolean>,
  cfg = makeTestConfig(),
) {
  return createReviewPublishSession({
    cfg,
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
  });
}

function buildTool(
  shouldAbortPublish?: () => Promise<boolean>,
  publishImpl?: PrSurface["publishThreadBatch"],
  cfg?: ReturnType<typeof makeTestConfig>,
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
    session: threadSession(surface, shouldAbortPublish, cfg),
    inventory: emptyInventory,
    initialLedger: createFindingLedger(),
  });
  return { tool, publishThreadBatch };
}

describe("buildPublishThreadTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextReviewId = 100;
  });

  it("asks one overlap round against earlier accepted findings, then publishes the answered batch", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");

    const first = await tool.executor({ findings: [finding(10)] });
    expect(first.kind).toBe("published");
    const [accepted] = tool.getLedger().accepted;
    if (accepted == null) throw new Error("expected an accepted finding");
    tool.setSource("security");

    const asked = await tool.executor({ findings: [finding(10), finding(20)] }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(asked).toMatchObject({ code: "review.publish_thread_overlap_unanswered" });
    const askedMessage = asked instanceof Error ? asked.message : "";
    expect(askedMessage.split(accepted.findingId)).toHaveLength(3);
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().threadCallCount).toBe(1);

    const second = await tool.executor({
      findings: [
        { ...finding(10), relation: { kind: "continues", findingId: accepted.findingId } },
        {
          ...finding(20),
          relation: {
            kind: "distinct_from",
            findingIds: [accepted.findingId],
            reason: "Different return path.",
          },
        },
      ],
    });

    expect(tool.piTool.name).toBe("publish_thread");
    expect(second.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledTimes(2);
    expect(publishThreadBatch.mock.calls[1]?.[0].comments).toHaveLength(1);
    expect(tool.getLedger().accepted.map((placement) => placement.source)).toEqual([
      "correctness",
      "security",
    ]);
    expect(tool.getLedger().reaffirmed).toEqual([
      expect.objectContaining({ id: accepted.findingId, source: "security", heldBy: "run" }),
    ]);
    expect(tool.getLedger().postedInlineCount).toBe(2);
    expect(tool.getLedger().threadCallCount).toBe(2);
    expect(tool.getPublishedBatchCount()).toBe(2);
  });

  it("lands still-unanswered overlaps summary-only once the round is spent", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");
    await tool.executor({ findings: [finding(10)] });
    tool.setSource("security");

    await expect(tool.executor({ findings: [finding(12)] })).rejects.toMatchObject({
      code: "review.publish_thread_overlap_unanswered",
    });
    const result = await tool.executor({ findings: [finding(12)] });

    expect(result.kind).toBe("empty");
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().accepted.at(-1)).toMatchObject({
      kind: "summary_only",
      source: "security",
      reason: "unanswered_overlap",
    });
  });

  it("retains budget-exhausted findings as summary-only ledger entries", async () => {
    const { tool } = buildTool(
      undefined,
      undefined,
      makeTestConfig({ review: { maxThreadPublishCalls: 1 } }),
    );
    tool.setSource("security");

    await tool.executor({ findings: [finding(10)] });
    const result = await tool.executor({ findings: [finding(40)] });

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
      session: threadSession(surface),
      inventory: emptyInventory,
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
