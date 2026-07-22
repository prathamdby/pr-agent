import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFindingLedger,
  type AcceptedPlacement,
  type FindingLedger,
  type ReviewCoverage,
} from "../src/review/orchestrator/orchestratorTypes.js";
import {
  buildPublishSummaryTool,
  createPublishSummaryState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/review/publish/publishSummaryOnly.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/review/publish/publishSummaryOnly.js")>();
  return {
    ...actual,
    publishReviewSummaryOnly: vi.fn(async () => ({ kind: "published", summaryCommentId: 91 })),
  };
});

function finding(line: number, severity: ReviewFinding["severity"] = "P1"): ReviewFinding {
  return {
    severity,
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Original title ${line}`,
    detail: `Original detail ${line}.`,
    fixPrompt: severity === "P3" ? undefined : `Original fix ${line}.`,
    confidence: 4,
    category: "bug",
  };
}

function accepted(
  findingId: string,
  item: ReviewFinding,
  kind: AcceptedPlacement["kind"] = "posted",
): AcceptedPlacement {
  const placement = {
    finding: item,
    inlineLine: kind === "summary_only" ? null : item.startLine,
    inlinePosted: kind !== "summary_only",
  };
  if (kind === "summary_only") {
    return {
      kind,
      source: "correctness",
      placement,
      canonicalFingerprint: findingId,
      reason: "anchor",
    };
  }
  return {
    kind,
    source: "correctness",
    placement,
    canonicalFingerprint: findingId,
    reviewId: item.startLine,
  };
}

function summaryInput(ids: readonly string[]) {
  return {
    prCharacter: "The change updates request routing.",
    findings: ids.map((findingId, index) => ({
      findingId,
      title: `Summary title ${index + 1}`,
      detail: `Summary detail ${index + 1}.`,
      fixPrompt: `Summary fix ${index + 1}.`,
      confidence: 5,
      category: "performance",
    })),
    estimatedEffort: 3,
    relevantTests: "partial",
    securityConcerns: null,
    followUps: ["Add a regression test."],
    mergeVerdict: {
      score: 3,
      rationale: "Blocking findings remain on this pass.",
    },
  };
}

function buildTool(params: {
  getLedger: () => FindingLedger;
  getToken?: () => string;
  getCoverage?: () => ReviewCoverage;
  state?: ReturnType<typeof createPublishSummaryState>;
}) {
  return buildPublishSummaryTool({
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionAgentBlock: false,
    },
    getToken: params.getToken ?? (() => "token"),
    getLedger: params.getLedger,
    getCoverage: params.getCoverage ?? (() => ({ kind: "full" })),
    state: params.state ?? createPublishSummaryState(),
  });
}

describe("buildPublishSummaryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishReviewSummaryOnly).mockResolvedValue({
      kind: "published",
      summaryCommentId: 91,
    });
  });

  it("reconstructs immutable finding placement fields from the live ledger", async () => {
    let ledger = createFindingLedger();
    const tool = buildTool({ getLedger: () => ledger });
    const first = finding(10);
    const second = finding(20, "P2");
    ledger = createFindingLedger({
      accepted: [accepted("finding-1", first), accepted("finding-2", second, "summary_only")],
      inlineReviewIds: [10],
      postedInlineCount: 1,
    });

    const result = await tool.executor(summaryInput(["finding-2", "finding-1"]));

    expect(tool.piTool.name).toBe("publish_summary");
    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.findings).toEqual([
      {
        severity: "P1",
        file: "src/a.ts",
        startLine: 10,
        endLine: 10,
        title: "Summary title 2",
        detail: "Summary detail 2.",
        fixPrompt: "Summary fix 2.",
        confidence: 5,
        category: "performance",
      },
      {
        severity: "P2",
        file: "src/a.ts",
        startLine: 20,
        endLine: 20,
        title: "Summary title 1",
        detail: "Summary detail 1.",
        fixPrompt: "Summary fix 1.",
        confidence: 5,
        category: "performance",
      },
    ]);
    expect(call?.ledger.accepted[0]?.placement.finding).toEqual(call?.payload.findings[0]);
    expect(call?.ledger.accepted[1]?.placement.finding).toEqual(call?.payload.findings[1]);
  });

  it.each([
    ["drops an accepted ID", ["finding-1"]],
    ["adds an unknown ID", ["finding-1", "finding-2", "finding-3"]],
    ["duplicates an ID", ["finding-1", "finding-1"]],
  ])("rejects a summary that %s", async (_name, ids) => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({
      accepted: [accepted("finding-1", finding(10)), accepted("finding-2", finding(20))],
    });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor(summaryInput(ids))).rejects.toMatchObject({
      code: "review.publish_summary_validation_failed",
    });

    expect(state.lastValidationError).toContain("exactly once");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("rejects an unknown ID even when the finding count matches", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({
      accepted: [accepted("finding-1", finding(10)), accepted("finding-2", finding(20))],
    });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(
      tool.executor(summaryInput(["finding-1", "unknown-finding"])),
    ).rejects.toMatchObject({ code: "review.publish_summary_validation_failed" });
    expect(state.lastValidationError).toContain("unknown-finding");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("stores formatted schema and semantic errors for repair", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor({ findings: [] })).rejects.toMatchObject({
      code: "review.publish_summary_validation_failed",
    });
    expect(state.lastValidationError).toContain("publish_summary validation failed:");

    await expect(
      tool.executor({
        ...summaryInput(["finding-1"]),
        mergeVerdict: { score: 5, rationale: "Safe to merge on this pass." },
      }),
    ).rejects.toMatchObject({ code: "review.publish_summary_semantic_validation_failed" });
    expect(state.lastValidationError).toContain("score must be <= 3");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("clears the validation error when a repaired call succeeds", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor({ findings: [] })).rejects.toMatchObject({
      code: "review.publish_summary_validation_failed",
    });
    expect(state.lastValidationError).not.toBeNull();

    const result = await tool.executor(summaryInput(["finding-1"]));

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    expect(state.lastValidationError).toBeNull();
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
  });

  it("publishes an empty summary for an empty accepted ledger", async () => {
    const ledger = createFindingLedger();
    const tool = buildTool({ getLedger: () => ledger });

    const result = await tool.executor(summaryInput([]));

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.findings).toEqual([]);
    expect(call?.ledger.accepted).toEqual([]);
  });

  it("latches only after a successful summary publish and ignores a duplicate call", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    const first = await tool.executor(summaryInput(["finding-1"]));
    const duplicate = await tool.executor(summaryInput(["finding-1"]));

    expect(first).toEqual({ ok: true, summaryCommentId: 91 });
    expect(duplicate).toEqual({ ok: true, duplicate: true });
    expect(state.published).toBe(true);
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
  });

  it("does not latch a stopped publish and passes through the live token getter", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    let token = "first-token";
    const tool = buildTool({ getLedger: () => ledger, getToken: () => token, state });
    vi.mocked(publishReviewSummaryOnly)
      .mockImplementationOnce(async (params) => {
        expect(params.getToken()).toBe("first-token");
        return { kind: "stopped", reason: "superseded" };
      })
      .mockImplementationOnce(async (params) => {
        expect(params.getToken()).toBe("refreshed-token");
        return { kind: "published", summaryCommentId: 92 };
      });

    const stopped = await tool.executor(summaryInput(["finding-1"]));
    token = "refreshed-token";
    const published = await tool.executor(summaryInput(["finding-1"]));

    expect(stopped).toEqual({ ok: false, reason: "superseded" });
    expect(published).toEqual({ ok: true, summaryCommentId: 92 });
    expect(state.published).toBe(true);
  });

  it("reads coverage after tool construction", async () => {
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    let coverage: ReviewCoverage = { kind: "full" };
    const tool = buildTool({
      getLedger: () => ledger,
      getCoverage: () => coverage,
    });
    coverage = {
      kind: "partial",
      failed: ["security"],
      note: "Coverage partial: security specialist failed.",
    };

    await tool.executor(summaryInput(["finding-1"]));

    expect(vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0].coverage).toEqual(coverage);
  });
});
