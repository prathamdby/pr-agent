import { describe, expect, it, vi } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { makeTestConfig } from "./helpers/config.js";
import {
  applyValidationVerdicts,
  collectHighRiskCandidates,
  runBatchValidation,
  type ValidationCandidate,
} from "../src/review/run/reviewValidation.js";
import type { CriticReport } from "../src/review/run/reviewCritics.js";
import { createReviewSessionRegistry } from "../src/review/run/reviewSessionRegistry.js";

function finding(
  overrides: Partial<CriticReport["findings"][number]> = {},
): CriticReport["findings"][number] {
  return {
    severity: "P1",
    file: "src/file.ts",
    startLine: 1,
    endLine: 1,
    title: "Finding",
    detail: "Detail",
    fixPrompt: "Fix",
    confidence: 5,
    category: "bug",
    evidence: "Evidence",
    ...overrides,
  };
}

function criticReport(critic: string, findings: CriticReport["findings"]): CriticReport {
  return {
    critic: critic as CriticReport["critic"],
    coverage: "covered",
    findings,
    residualRisks: [],
    testingGaps: [],
  };
}

function mockSession(send: () => Promise<{ text: string }>) {
  return {
    send: vi.fn(send),
    restrictToTools: vi.fn(),
    restoreTools: vi.fn(),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

const investigationTools = {
  piTools: [{ name: "readWorkspaceFile" }] as unknown as readonly PiTool[],
  executors: {
    readWorkspaceFile: vi.fn(async () => ({ content: "file" })),
  },
};

describe("collectHighRiskCandidates", () => {
  it("collects only P0 and P1 findings in critic-then-finding order", () => {
    const reports: CriticReport[] = [
      criticReport("correctness", [
        finding({ severity: "P0", file: "a.ts", startLine: 1, endLine: 1 }),
        finding({ severity: "P2", file: "b.ts", startLine: 2, endLine: 2 }),
        finding({ severity: "P1", file: "c.ts", startLine: 3, endLine: 3 }),
      ]),
      criticReport("security", [
        finding({ severity: "P3", file: "d.ts", startLine: 4, endLine: 4 }),
        finding({ severity: "P1", file: "e.ts", startLine: 5, endLine: 5 }),
      ]),
    ];
    const candidates = collectHighRiskCandidates(reports);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(candidates[0].critic).toBe("correctness");
    expect(candidates[0].finding.severity).toBe("P0");
    expect(candidates[1].critic).toBe("correctness");
    expect(candidates[1].finding.severity).toBe("P1");
    expect(candidates[2].critic).toBe("security");
  });

  it("returns empty for reports with no P0/P1", () => {
    const reports: CriticReport[] = [
      criticReport("correctness", [finding({ severity: "P2" }), finding({ severity: "P3" })]),
    ];
    expect(collectHighRiskCandidates(reports)).toEqual([]);
  });
});

describe("applyValidationVerdicts", () => {
  it("removes only refuted findings", () => {
    const reports: CriticReport[] = [
      criticReport("correctness", [
        finding({ severity: "P0", file: "a.ts" }),
        finding({ severity: "P1", file: "b.ts" }),
      ]),
    ];
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: reports[0].findings[0] },
      { id: "c2", critic: "correctness", findingIndex: 1, finding: reports[0].findings[1] },
    ];
    const verdictById = new Map([
      ["c1", "refuted" as const],
      ["c2", "confirmed" as const],
    ]);
    const result = applyValidationVerdicts(reports, candidates, verdictById);
    expect(result.removedCount).toBe(1);
    expect(result.reports[0].findings).toHaveLength(1);
    expect(result.reports[0].findings[0].file).toBe("b.ts");
  });

  it("preserves unverifiable findings", () => {
    const reports: CriticReport[] = [
      criticReport("correctness", [finding({ severity: "P0", file: "a.ts" })]),
    ];
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: reports[0].findings[0] },
    ];
    const verdictById = new Map([["c1", "unverifiable" as const]]);
    const result = applyValidationVerdicts(reports, candidates, verdictById);
    expect(result.removedCount).toBe(0);
    expect(result.unvalidatedCount).toBe(1);
    expect(result.reports[0].findings).toHaveLength(1);
  });

  it("preserves findings with missing verdicts (fail-open)", () => {
    const reports: CriticReport[] = [
      criticReport("correctness", [finding({ severity: "P1", file: "a.ts" })]),
    ];
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: reports[0].findings[0] },
    ];
    const verdictById = new Map<string, "confirmed" | "refuted" | "unverifiable">();
    const result = applyValidationVerdicts(reports, candidates, verdictById);
    expect(result.removedCount).toBe(0);
    expect(result.unvalidatedCount).toBe(1);
    expect(result.reports[0].findings).toHaveLength(1);
  });
});

describe("runBatchValidation", () => {
  it("returns all unverifiable when no candidates", async () => {
    const result = await runBatchValidation({
      cfg: makeTestConfig(),
      runner: { createSession: vi.fn() },
      candidates: [],
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.verdictById.size).toBe(0);
    expect(result.failedOpen).toBe(false);
  });

  it("applies confirmed and refuted verdicts from the batch", async () => {
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: finding({ severity: "P0" }) },
      { id: "c2", critic: "security", findingIndex: 0, finding: finding({ severity: "P1" }) },
    ];
    const createSession = vi.fn(
      async (params: {
        executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      }) =>
        mockSession(async () => {
          await params.executors.submitValidationBatch?.({
            verdicts: [
              { id: "c1", verdict: "confirmed", reason: "real" },
              { id: "c2", verdict: "refuted", reason: "wrong" },
            ],
          });
          return { text: "done" };
        }),
    );
    const result = await runBatchValidation({
      cfg: makeTestConfig(),
      runner: { createSession },
      candidates,
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.verdictById.get("c1")).toBe("confirmed");
    expect(result.verdictById.get("c2")).toBe("refuted");
    expect(result.failedOpen).toBe(false);
  });

  it("fails open when the validator session throws", async () => {
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: finding({ severity: "P0" }) },
    ];
    const createSession = vi.fn(async () => {
      throw new Error("session creation failed");
    });
    const result = await runBatchValidation({
      cfg: makeTestConfig(),
      runner: { createSession },
      candidates,
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.failedOpen).toBe(true);
    expect(result.verdictById.get("c1")).toBe("unverifiable");
  });

  it("ignores unknown and duplicate IDs in verdicts", async () => {
    const candidates: ValidationCandidate[] = [
      { id: "c1", critic: "correctness", findingIndex: 0, finding: finding({ severity: "P0" }) },
    ];
    const createSession = vi.fn(
      async (params: {
        executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      }) =>
        mockSession(async () => {
          await params.executors.submitValidationBatch?.({
            verdicts: [
              { id: "c1", verdict: "refuted", reason: "wrong" },
              { id: "c1", verdict: "confirmed", reason: "dup" },
              { id: "unknown", verdict: "confirmed", reason: "unknown" },
            ],
          });
          return { text: "done" };
        }),
    );
    const result = await runBatchValidation({
      cfg: makeTestConfig(),
      runner: { createSession },
      candidates,
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.verdictById.get("c1")).toBe("refuted");
  });
});
