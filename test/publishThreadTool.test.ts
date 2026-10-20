import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const decisionRows = vi.hoisted(() => {
  const rows: Array<{ detail?: { severityRaised?: number; severityLowered?: number } }> = [];
  return { rows };
});

vi.mock("../src/agentWork/agentEventsRepository.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/agentEventsRepository.ts")>();
  return {
    ...actual,
    safeAppendAgentEvents: (
      _client: unknown,
      cfg: { agentEvents: { enabled: boolean } },
      rows: Array<{ detail?: { severityRaised?: number; severityLowered?: number } }>,
    ) => {
      if (!cfg.agentEvents.enabled) return;
      decisionRows.rows.push(...rows);
    },
  };
});
import { candidateFindingId } from "../src/review/orchestrator/judgmentDisposition.ts";
import type { SpecialistReport } from "../src/review/orchestrator/specialistReport.ts";
import { NO_CANDIDATE_TEST_GAP } from "../src/review/orchestrator/testsEvidence.ts";
import {
  createFindingLedger,
  type SpecialistId,
} from "../src/review/orchestrator/orchestratorTypes.ts";
import {
  createOrchestratorPhaseRef,
  WRONG_PHASE_TOOL_CODE,
} from "../src/review/orchestrator/phaseToolPolicy.ts";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.ts";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.ts";
import type { ReviewFinding } from "../src/review/reviewSchema.ts";
import { makeTestConfig } from "./helpers/config.ts";
import {
  cachedDiffForLines,
  completeFindingInventory,
} from "./helpers/reviewPublishTestHelpers.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import type { PrSurface } from "../src/github/prSurface.ts";
const emptyInventory = completeFindingInventory();
const eventPool = new Pool();

let nextReviewId = 100;

function finding(line: number): ReviewFinding {
  return {
    severity: "P1",
    severityRationale: "The trigger is reachable in the changed branch.",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The changed path at line ${line} returns the wrong value.`,
    fixPrompt: `Correct the path at line ${line}.`,
  };
}

function acceptedDispositions(source: SpecialistId, findings: readonly ReviewFinding[]) {
  const byId = new Map<string, { candidateId: string; verdict: "accepted"; reason: "confirmed" }>();
  for (const row of findings) {
    const candidateId = candidateFindingId({
      specialist: source,
      file: row.file,
      startLine: row.startLine,
      endLine: row.endLine,
      title: row.title,
    });
    byId.set(candidateId, { candidateId, verdict: "accepted", reason: "confirmed" });
  }
  return [...byId.values()];
}

function remember(
  tool: {
    setReport: (report: SpecialistReport) => void;
  },
  findings: readonly ReviewFinding[],
) {
  tool.setReport({
    status: findings.length === 0 ? "no_findings" : "findings",
    findings: findings.map((row) => ({
      suggestedSeverity: row.severity,
      file: row.file,
      startLine: row.startLine,
      endLine: row.endLine,
      title: row.title,
      detail: row.detail,
      fixPrompt: row.fixPrompt,
    })),
  });
}

function judged(source: SpecialistId, findings: ReviewFinding | readonly ReviewFinding[]) {
  const rows = Array.isArray(findings) ? findings : [findings];
  return { findings, dispositions: acceptedDispositions(source, rows) };
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
    findingInventory: emptyInventory,
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
    recordPublishStep: vi.fn(async () => undefined),
    shouldAbortPublish,
    agentEvents: {
      pool: eventPool,
      workItemId: "wi-1",
      installationId: 1,
      owner: "o",
      repo: "r",
      prNumber: 1,
    },
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
  afterAll(async () => {
    await eventPool.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    nextReviewId = 100;
    decisionRows.rows.length = 0;
  });

  it("asks one overlap round against earlier accepted findings, then publishes the answered batch", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");
    remember(tool, [finding(10)]);

    const first = await tool.executor(judged("correctness", [finding(10)]));
    expect(first.kind).toBe("published");
    const [accepted] = tool.getLedger().accepted;
    if (accepted == null) throw new Error("expected an accepted finding");
    tool.setSource("security");
    remember(tool, [finding(10), finding(20)]);

    const asked = await tool.executor(judged("security", [finding(10), finding(20)])).then(
      () => null,
      (error: unknown) => error,
    );
    expect(asked).toMatchObject({ code: "review.publish_thread_overlap_unanswered" });
    const askedMessage = asked instanceof Error ? asked.message : "";
    expect(askedMessage.split(accepted.findingId)).toHaveLength(3);
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().threadCallCount).toBe(1);

    const answered = [
      { ...finding(10), relation: { kind: "continues" as const, findingId: accepted.findingId } },
      {
        ...finding(20),
        relation: {
          kind: "distinct_from" as const,
          findingIds: [accepted.findingId],
          reason: "Different return path.",
        },
      },
    ];
    remember(tool, answered);
    const second = await tool.executor(judged("security", answered));

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
    remember(tool, [finding(10)]);
    await tool.executor(judged("correctness", [finding(10)]));
    tool.setSource("security");
    remember(tool, [finding(12)]);

    await expect(tool.executor(judged("security", [finding(12)]))).rejects.toMatchObject({
      code: "review.publish_thread_overlap_unanswered",
    });
    const result = await tool.executor(judged("security", [finding(12)]));

    expect(result.kind).toBe("empty");
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().accepted.at(-1)).toMatchObject({
      kind: "summary_only",
      source: "security",
      reason: "unanswered_overlap",
    });
  });

  it("publishes one thread for repeated findings within one batch", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("correctness");
    const repeated = [
      finding(10),
      { ...finding(10), severity: "P0" as const, startLine: 9, title: "BUG at line 10!" },
      { ...finding(10), detail: "Same location and title, reworded detail." },
    ];
    remember(tool, repeated);

    const result = await tool.executor(judged("correctness", repeated));

    expect(result.kind).toBe("published");
    expect(publishThreadBatch.mock.calls[0]?.[0].comments).toHaveLength(1);
    const accepted = tool.getLedger().accepted;
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.placement.finding.severity).toBe("P0");
  });

  it("retains budget-exhausted findings as summary-only ledger entries", async () => {
    const { tool } = buildTool(
      undefined,
      undefined,
      makeTestConfig({ review: { maxThreadPublishCalls: 1 } }),
    );
    tool.setSource("security");

    remember(tool, [finding(10)]);
    await tool.executor(judged("security", [finding(10)]));
    remember(tool, [finding(40)]);
    const result = await tool.executor(judged("security", [finding(40)]));

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
    remember(tool, [finding(10)]);

    const result = await tool.executor(judged("correctness", finding(10)));

    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
    expect(tool.getLedger().accepted).toHaveLength(1);
  });

  it("rejects malformed calls and calls made before a specialist source is selected", async () => {
    const { tool, publishThreadBatch } = buildTool();

    await expect(tool.executor({ findings: "not-an-array" })).rejects.toMatchObject({
      code: "review.publish_thread_validation_failed",
    });
    await expect(tool.executor(judged("correctness", [finding(10)]))).rejects.toMatchObject({
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
    remember(tool, [finding(10)]);

    const result = await tool.executor(judged("tests", [finding(10)]));

    expect(result.kind).toBe("stopped");
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(publishThreadBatch).not.toHaveBeenCalled();
  });

  it("leaves the ledger unchanged when GitHub publish throws", async () => {
    const { tool, publishThreadBatch } = buildTool(undefined, async () => {
      throw new Error("GitHub unavailable");
    });
    tool.setSource("quality");
    remember(tool, [finding(10)]);

    await expect(tool.executor(judged("quality", [finding(10)]))).rejects.toMatchObject({
      code: "review.publish_thread_failed",
    });

    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(tool.getPublishedBatchCount()).toBe(0);
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
  });

  it("reuses the same finding ids when a failed publish is called again", async () => {
    let calls = 0;
    const { tool, publishThreadBatch } = buildTool(undefined, async () => {
      calls += 1;
      if (calls === 1) throw new Error("GitHub unavailable");
      return { reviewId: 200, reviewUrl: "https://example.com/reviews/200" };
    });
    tool.setSource("quality");
    remember(tool, [finding(10)]);

    await expect(tool.executor(judged("quality", [finding(10)]))).rejects.toMatchObject({
      code: "review.publish_thread_failed",
    });
    const result = await tool.executor(judged("quality", [finding(10)]));

    expect(result.kind).toBe("published");
    const bodies = publishThreadBatch.mock.calls.map((call) =>
      call[0].comments?.map((comment) => comment.body),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("publishes the capped judged severity and keeps the rationale off the thread", async () => {
    const { tool, publishThreadBatch } = buildTool();
    tool.setSource("tests");
    tool.setReport({
      status: "findings",
      findings: [
        {
          suggestedSeverity: "P0",
          file: "src/a.ts",
          startLine: 10,
          endLine: 10,
          title: "Bug at line 10",
          detail: "The changed path at line 10 returns the wrong value.",
          fixPrompt: "Correct the path at line 10.",
        },
      ],
    });

    const published = [
      {
        ...finding(10),
        severity: "P0" as const,
        severityRationale: "RATIONALE_TOKEN_786",
        suggestedSeverity: "SUGGESTED_P0_TOKEN",
      },
    ];
    const result = await tool.executor(judged("tests", published));

    expect(result.kind).toBe("published");
    const stored = tool.getLedger().accepted[0]?.placement.finding;
    expect(stored?.severity).toBe("P2");
    const body = publishThreadBatch.mock.calls[0]?.[0].comments?.[0]?.body ?? "";
    expect(body).toContain("**P2**");
    expect(body).toContain("sev=P2");
    expect(body).not.toContain("RATIONALE_TOKEN_786");
    expect(body).not.toContain("SUGGESTED_P0_TOKEN");
    expect(stored).not.toHaveProperty("suggestedSeverity");
    expect(decisionRows.rows.at(-1)?.detail).toMatchObject({
      severityRaised: 0,
      severityLowered: 1,
    });
  });

  it("caps a judged finding on a test path at P2", async () => {
    const pathTool = buildTool();
    const rows = [{ ...finding(10), severity: "P0" as const, file: "src/widget.test.ts" }];
    pathTool.tool.setSource("correctness");
    remember(pathTool.tool, rows);
    await pathTool.tool.executor(judged("correctness", rows));
    expect(pathTool.tool.getLedger().accepted[0]?.placement.finding.severity).toBe("P2");
  });

  it("rejects a publish_thread call that omits the severity rationale", async () => {
    const { tool } = buildTool();
    tool.setSource("correctness");
    const { severityRationale: _rationale, ...withoutRationale } = finding(10);

    await expect(tool.executor({ findings: [withoutRationale] })).rejects.toMatchObject({
      code: "review.publish_thread_validation_failed",
    });
    expect(tool.getLedger().accepted).toEqual([]);
  });

  it("counts neither a raise nor a downgrade when the report row is split", async () => {
    const { tool } = buildTool();
    tool.setSource("correctness");
    const row = {
      suggestedSeverity: "P2" as const,
      file: "src/a.ts",
      startLine: 10,
      endLine: 10,
      title: "Bug at line 10",
      detail: "The changed path at line 10 returns the wrong value.",
      fixPrompt: "Correct the path at line 10.",
    };
    tool.setReport({
      status: "findings",
      findings: [row, { ...row, detail: "A second report row." }],
    });
    await tool.executor(judged("correctness", [{ ...finding(10), severity: "P0" }]));
    expect(decisionRows.rows.at(-1)?.detail).toMatchObject({
      severityRaised: 0,
      severityLowered: 0,
    });
  });

  it("stores one disposition per candidate and drops a secret note", async () => {
    const { tool } = buildTool();
    tool.setSource("correctness");
    const kept = finding(10);
    const dropped = finding(20);
    tool.setReport({
      status: "findings",
      findings: [kept, dropped].map((row) => ({
        suggestedSeverity: row.severity,
        file: row.file,
        startLine: row.startLine,
        endLine: row.endLine,
        title: row.title,
        detail: row.detail,
        fixPrompt: row.fixPrompt,
      })),
    });
    const keptId = candidateFindingId({ specialist: "correctness", ...kept });
    const droppedId = candidateFindingId({ specialist: "correctness", ...dropped });
    const result = await tool.executor({
      findings: [kept],
      dispositions: [
        { candidateId: keptId, verdict: "accepted", reason: "confirmed", note: "Empty cart." },
        {
          candidateId: droppedId,
          verdict: "rejected",
          reason: "guarded",
          note: "sk_live_abcdefghij",
        },
      ],
    });

    expect(result.kind).toBe("published");
    const minted = tool.getLedger().accepted[0]?.findingId;
    expect(decisionRows.rows.at(-1)?.detail).toMatchObject({
      dispositions: [
        { id: minted, verdict: "accepted", reason: "confirmed", note: "Empty cart." },
        { id: droppedId, verdict: "rejected", reason: "guarded" },
      ],
    });
    expect(JSON.stringify(decisionRows.rows.at(-1)?.detail)).not.toContain("sk_live_");
  });

  it("rejects a coverage gap above its evidence ceiling and keeps a legal raise", async () => {
    const { tool } = buildTool();
    tool.setSource("tests");
    const row = {
      suggestedSeverity: "P2" as const,
      file: "src/a.ts",
      startLine: 10,
      endLine: 10,
      title: "Bug at line 10",
      detail: "The changed path at line 10 returns the wrong value.",
      fixPrompt: "Correct the path at line 10.",
      testsClaim: "coverage_gap" as const,
      testEvidence: {
        searched: ["payment total"],
        read: [] as string[],
        gap: NO_CANDIDATE_TEST_GAP,
      },
    };
    tool.setReport({ status: "findings", findings: [row] });
    await expect(
      tool.executor(judged("tests", [{ ...finding(10), severity: "P0" }])),
    ).rejects.toMatchObject({ code: "review.publish_thread_validation_failed" });
    expect(tool.getLedger().accepted).toEqual([]);

    tool.setReport({
      status: "findings",
      findings: [
        {
          ...row,
          testEvidence: { ...row.testEvidence, criticalPath: "money" as const },
        },
      ],
    });
    const raised = await tool.executor(judged("tests", [{ ...finding(10), severity: "P0" }]));
    expect(raised.kind).toBe("published");
    expect(tool.getLedger().accepted[0]?.placement.finding.severity).toBe("P0");
  });
});
