import { describe, expect, it } from "vitest";
import { MAX_SPECIALIST_FINDINGS } from "../src/settings/index.js";
import {
  SPECIALIST_IDS,
  specialistReportSchema,
} from "../src/review/orchestrator/specialistReport.js";

function makeFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "P1",
    file: "src/handler.ts",
    startLine: 10,
    endLine: 10,
    title: "Missing await on promise",
    detail: "The handler returns before the async work completes.",
    fixPrompt: "Await the promise before returning so errors propagate.",
    ...overrides,
  };
}

describe("SPECIALIST_IDS", () => {
  it("is the fixed four-specialist roster in order", () => {
    expect(SPECIALIST_IDS).toEqual(["correctness", "security", "quality", "tests"]);
  });
});

describe("specialistReportSchema", () => {
  it("accepts a findings report with at least one finding", () => {
    const parsed = specialistReportSchema.parse({
      status: "findings",
      findings: [makeFinding()],
    });
    expect(parsed.status).toBe("findings");
    expect(parsed.findings).toHaveLength(1);
  });

  it("accepts an explicit no_findings report and defaults findings to []", () => {
    const parsed = specialistReportSchema.parse({ status: "no_findings" });
    expect(parsed.status).toBe("no_findings");
    expect(parsed.findings).toEqual([]);
  });

  it("rejects status 'findings' with an empty findings array", () => {
    const result = specialistReportSchema.safeParse({ status: "findings", findings: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /at least one finding/.test(i.message))).toBe(true);
    }
  });

  it("rejects status 'no_findings' that still carries findings", () => {
    const result = specialistReportSchema.safeParse({
      status: "no_findings",
      findings: [makeFinding()],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /must not carry findings/.test(i.message))).toBe(true);
    }
  });

  it("caps findings at MAX_SPECIALIST_FINDINGS", () => {
    const overCap = Array.from({ length: MAX_SPECIALIST_FINDINGS + 1 }, () => makeFinding());
    const result = specialistReportSchema.safeParse({ status: "findings", findings: overCap });
    expect(result.success).toBe(false);

    const atCap = Array.from({ length: MAX_SPECIALIST_FINDINGS }, () => makeFinding());
    expect(specialistReportSchema.safeParse({ status: "findings", findings: atCap }).success).toBe(
      true,
    );
  });

  it("reuses the canonical review finding schema (P0/P1/P2 require fixPrompt)", () => {
    const result = specialistReportSchema.safeParse({
      status: "findings",
      findings: [makeFinding({ fixPrompt: undefined })],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional notes but caps their length", () => {
    expect(
      specialistReportSchema.safeParse({ status: "no_findings", notes: "looked clean" }).success,
    ).toBe(true);
    expect(
      specialistReportSchema.safeParse({ status: "no_findings", notes: "x".repeat(4001) }).success,
    ).toBe(false);
  });
});
