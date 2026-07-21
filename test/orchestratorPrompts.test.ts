import { describe, expect, it } from "vitest";
import { renderJudgmentTurn } from "../src/review/orchestrator/prompts/orchestratorPrompts.js";
import type { SpecialistOutcome } from "../src/review/orchestrator/specialistReport.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/auth.ts",
    startLine: 10,
    endLine: 12,
    title: "Missing authz check",
    detail: "Endpoint skips the role gate.",
    fixPrompt: "Enforce the role gate before mutating state.",
    ...overrides,
  };
}

function reportOutcome(
  specialist: SpecialistOutcome["specialist"],
  findings: ReviewFinding[],
): Extract<SpecialistOutcome, { kind: "report" }> {
  return {
    specialist,
    kind: "report",
    report: { status: "findings", findings },
    durationMs: 12,
  };
}

describe("renderJudgmentTurn same-file overlap hints", () => {
  it("includes compact prior same-file thread hints before publish, omitting unrelated files", () => {
    const incoming = reportOutcome("security", [
      finding({
        title: "Authorization bypass on write path",
        startLine: 14,
        endLine: 14,
      }),
    ]);
    const previouslyAccepted: ReviewFinding[] = [
      finding({
        title: "Missing authz check",
        startLine: 10,
        endLine: 12,
      }),
      finding({
        file: "src/unrelated.ts",
        title: "Unused import",
        startLine: 1,
        endLine: 1,
      }),
    ];

    const body = renderJudgmentTurn(incoming, { previouslyAcceptedFindings: previouslyAccepted });

    expect(body).toContain("## Already published / accepted on same files");
    expect(body).toContain("`src/auth.ts`");
    expect(body).toContain("Missing authz check");
    expect(body).toContain("L10-L12");
    expect(body).not.toContain("src/unrelated.ts");
    expect(body).not.toContain("Unused import");
    expect(body).toMatch(/before calling `publish_thread`|before you call `publish_thread`/i);
  });

  it("omits the same-file hints section when no prior accepted findings share a file", () => {
    const incoming = reportOutcome("quality", [finding({ file: "src/new.ts" })]);
    const body = renderJudgmentTurn(incoming, {
      previouslyAcceptedFindings: [finding({ file: "src/other.ts", title: "Other" })],
    });
    expect(body).not.toContain("## Already published / accepted on same files");
    expect(body).not.toContain("Other");
  });
});
