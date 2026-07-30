import { describe, expect, it } from "vitest";
import {
  countAcceptedForSource,
  createFindingLedger,
  specialistDonePhase,
  type AcceptedPlacement,
  type FindingLedger,
} from "../src/review/orchestrator/orchestratorTypes.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";

function finding(title: string): ReviewFinding {
  return {
    severity: "P3",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    title,
    detail: "detail",
    fixPrompt: "fix it.",
  };
}

function placement(
  kind: AcceptedPlacement["kind"],
  source: AcceptedPlacement["source"],
  title: string,
  reason?: Extract<AcceptedPlacement, { kind: "summary_only" }>["reason"],
): AcceptedPlacement {
  const base = {
    source,
    placement: {
      finding: finding(title),
      inlineLine: kind === "summary_only" ? null : 1,
      inlinePosted: kind !== "summary_only",
    },
    canonicalFingerprint: `${source}:${title}`,
  } as const;
  if (kind === "summary_only") {
    return { kind, ...base, reason: reason ?? "anchor" };
  }
  return { kind, ...base, reviewId: 1 };
}

function ledger(accepted: readonly AcceptedPlacement[]): FindingLedger {
  return createFindingLedger({ accepted });
}

describe("countAcceptedForSource", () => {
  it("counts posted and summary-only for one specialist only", () => {
    const state = ledger([
      placement("posted", "correctness", "inline"),
      placement("summary_only", "correctness", "summary", "anchor"),
      placement("summary_only", "security", "other", "budget"),
    ]);

    expect(countAcceptedForSource(state, "correctness")).toBe(2);
    expect(countAcceptedForSource(state, "security")).toBe(1);
    expect(countAcceptedForSource(state, "tests")).toBe(0);
  });
});

describe("specialistDonePhase", () => {
  it("uses accepted delta including summary-only only findings", () => {
    const before = ledger([placement("posted", "security", "prior")]);
    const after = ledger([
      placement("posted", "security", "prior"),
      placement("summary_only", "correctness", "off-diff", "anchor"),
      placement("summary_only", "correctness", "budgeted", "budget"),
    ]);

    expect(specialistDonePhase(before, after, "correctness")).toEqual({
      phase: "done",
      findingsAccepted: 2,
    });
  });

  it("maps zero new acceptances to done with findingsAccepted 0", () => {
    const empty = ledger([]);
    expect(specialistDonePhase(empty, empty, "quality")).toEqual({
      phase: "done",
      findingsAccepted: 0,
    });
  });

  it("counts mixed posted and summary-only for the same specialist", () => {
    const before = ledger([]);
    const after = ledger([
      placement("posted", "tests", "inline-p3"),
      placement("summary_only", "tests", "summary-p3", "anchor"),
    ]);

    expect(specialistDonePhase(before, after, "tests").findingsAccepted).toBe(2);
  });
});
