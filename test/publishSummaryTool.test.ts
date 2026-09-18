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
import {
  REVIEW_PUBLISH_SUMMARY_FIELDS,
  type ReviewFinding,
  type ReviewPayload,
} from "../src/review/reviewSchema.js";
import { REVIEW_GATE_PROSE_MAX_CHARS } from "../src/settings/index.js";
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

function summaryInput(
  overrides: Partial<Pick<ReviewPayload, (typeof REVIEW_PUBLISH_SUMMARY_FIELDS)[number]>> = {},
) {
  return {
    size: "M",
    followUps: ["Add a regression test."],
    mergeability: "Two-way: trivial to revert; only error-message rendering.",
    blastRadius: "Localized: stream error text only; no API or schema change.",
    ...overrides,
  };
}

function buildTool(params: {
  getLedger: () => FindingLedger;
  getCoverage?: () => ReviewCoverage;
  state?: ReturnType<typeof createPublishSummaryState>;
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

  it("publishes ledger finding copy verbatim and ignores model-supplied finding fields", async () => {
    let ledger = createFindingLedger();
    const tool = buildTool({ getLedger: () => ledger });
    const first = finding(10);
    const second = finding(20, "P2");
    ledger = createFindingLedger({
      accepted: [accepted("finding-1", first), accepted("finding-2", second, "summary_only")],
      inlineReviewIds: [10],
      postedInlineCount: 1,
    });

    const result = await tool.executor({
      ...summaryInput(),
      findings: [
        {
          findingId: "finding-1",
          title: "Forged summary title",
          detail: "Forged summary detail.",
        },
      ],
    });

    expect(tool.piTool.name).toBe("publish_summary");
    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.findings).toEqual([first, second]);
    expect(call?.payload.size).toBe("M");
    expect(call?.payload.followUps).toEqual(["Add a regression test."]);
    expect(call?.payload.mergeability).toBe(
      "Two-way: trivial to revert; only error-message rendering.",
    );
    expect(call?.payload.blastRadius).toBe(
      "Localized: stream error text only; no API or schema change.",
    );
    expect(call?.ledger.accepted).toEqual(ledger.accepted);
  });

  it("repairs a bare-string followUps field at the parse seam", async () => {
    const ledger = createFindingLedger({
      accepted: [accepted("finding-1", finding(10))],
      inlineReviewIds: [10],
      postedInlineCount: 1,
    });
    const tool = buildTool({ getLedger: () => ledger });

    const result = await tool.executor({
      ...summaryInput(),
      followUps: "Add a regression test.",
    });

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.followUps).toEqual(["Add a regression test."]);
  });

  it("stores formatted schema and semantic errors for repair", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor({})).rejects.toMatchObject({
      code: "review.publish_summary_validation_failed",
    });
    expect(state.lastValidationError).toContain("publish_summary validation failed:");

    await expect(
      tool.executor(
        summaryInput({ followUps: ["Structured publish failed after 2/3 attempt(s)."] }),
      ),
    ).rejects.toMatchObject({ code: "review.publish_summary_semantic_validation_failed" });
    expect(state.lastValidationError).toContain("followUps[0]");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();

    await expect(tool.executor(summaryInput({ mergeability: "   " }))).rejects.toMatchObject({
      code: "review.publish_summary_semantic_validation_failed",
    });
    expect(state.lastValidationError).toContain("mergeability must be one non-empty line");

    await expect(
      tool.executor(summaryInput({ mergeability: "x".repeat(REVIEW_GATE_PROSE_MAX_CHARS + 1) })),
    ).rejects.toMatchObject({ code: "review.publish_summary_validation_failed" });
    expect(state.lastValidationError).toContain("mergeability");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("clears the validation error when a repaired call succeeds", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor({})).rejects.toMatchObject({
      code: "review.publish_summary_validation_failed",
    });
    expect(state.lastValidationError).not.toBeNull();

    const result = await tool.executor(summaryInput());

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    expect(state.lastValidationError).toBeNull();
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid mergeability after a semantic failure", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    await expect(tool.executor(summaryInput({ mergeability: "\n" }))).rejects.toMatchObject({
      code: "review.publish_summary_semantic_validation_failed",
    });
    expect(state.lastValidationError).toContain("mergeability");

    const result = await tool.executor(summaryInput());

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    expect(state.lastValidationError).toBeNull();
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
  });

  it("publishes an empty summary for an empty accepted ledger", async () => {
    const ledger = createFindingLedger();
    const tool = buildTool({ getLedger: () => ledger });

    const result = await tool.executor(summaryInput());

    expect(result).toEqual({ ok: true, summaryCommentId: 91 });
    const call = vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0];
    expect(call?.payload.findings).toEqual([]);
    expect(call?.ledger.accepted).toEqual([]);
  });

  it("latches only after a successful summary publish and ignores a duplicate call", async () => {
    const state = createPublishSummaryState();
    const ledger = createFindingLedger({ accepted: [accepted("finding-1", finding(10))] });
    const tool = buildTool({ getLedger: () => ledger, state });

    const first = await tool.executor(summaryInput());
    const duplicate = await tool.executor(summaryInput());

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

    const stopped = await tool.executor(summaryInput());
    const published = await tool.executor(summaryInput());

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

    await tool.executor(summaryInput());

    expect(vi.mocked(publishReviewSummaryOnly).mock.calls[0]?.[0].coverage).toEqual(coverage);
  });
});
