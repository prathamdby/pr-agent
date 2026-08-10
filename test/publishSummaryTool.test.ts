import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFindingLedger,
  type AcceptedPlacement,
  type FindingLedger,
  type ReviewCoverage,
} from "../src/review/orchestrator/orchestratorTypes.js";
import {
  createOrchestratorPhaseRef,
  WRONG_PHASE_TOOL_CODE,
} from "../src/review/orchestrator/phaseToolPolicy.js";
import {
  buildPublishSummaryTool,
  createPublishSummaryState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

function reviewPrSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface;
}

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
    fixPrompt: `Original fix ${line}.`,
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
  };
}

function buildTool(params: {
  getLedger: () => FindingLedger;
  getCoverage?: () => ReviewCoverage;
  state?: ReturnType<typeof createPublishSummaryState>;
  ciAuthor?: Parameters<typeof buildPublishSummaryTool>[0]["ciAuthor"];
}) {
  return buildPublishSummaryTool({
    phaseRef: createOrchestratorPhaseRef("synthesis"),
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionReviewMap: false,
    },
    prSurface: reviewPrSurface(),
    getLedger: params.getLedger,
    getCoverage: params.getCoverage ?? (() => ({ kind: "full" })),
    state: params.state ?? createPublishSummaryState(),
    ciAuthor: params.ciAuthor,
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

  it("rejects wrong-phase calls before publish with a structured shape", async () => {
    const state = createPublishSummaryState();
    const tool = buildPublishSummaryTool({
      phaseRef: createOrchestratorPhaseRef("judgment"),
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "abc1234",
        hasDescriptionReviewMap: false,
      },
      prSurface: reviewPrSurface(),
      getLedger: () => createFindingLedger(),
      getCoverage: () => ({ kind: "full" }),
      state,
    });

    const result = await tool.executor({});

    expect(result).toEqual({
      ok: false,
      code: WRONG_PHASE_TOOL_CODE,
      phase: "judgment",
      allowed: ["publish_thread"],
      error: expect.stringContaining("publish_summary"),
    });
    expect(state.published).toBe(false);
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
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

  it("repairs a bare-string followUps field at the parse seam", async () => {
    const ledger = createFindingLedger({
      accepted: [accepted("finding-1", finding(10))],
      inlineReviewIds: [10],
      postedInlineCount: 1,
    });
    const tool = buildTool({ getLedger: () => ledger });

    const result = await tool.executor({
      ...summaryInput(["finding-1"]),
      followUps: "Add a regression test.",
    });

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.followUps).toEqual(["Add a regression test."]);
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
        securityConcerns: "Structured publish failed after 2/3 attempt(s).",
      }),
    ).rejects.toMatchObject({ code: "review.publish_summary_semantic_validation_failed" });
    expect(state.lastValidationError).toContain("securityConcerns");
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

  it("does not latch a stopped publish and allows a later successful publish", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });
    vi.mocked(publishReviewSummaryOnly)
      .mockImplementationOnce(async () => ({ kind: "stopped", reason: "superseded" }))
      .mockImplementationOnce(async () => ({ kind: "published", summaryCommentId: 92 }));

    const stopped = await tool.executor(summaryInput(["finding-1"]));
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

  it("forwards ciAuthor to publishReviewSummaryOnly", async () => {
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const ciAuthor = vi.fn(async () => null);
    const tool = buildTool({ getLedger: () => ledger, ciAuthor });

    await tool.executor(summaryInput(["finding-1"]));

    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.ciAuthor).toBe(ciAuthor);
  });
});
