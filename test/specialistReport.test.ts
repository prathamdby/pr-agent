import { describe, expect, it } from "vitest";
import { specialistReportSchema } from "../src/review/orchestrator/specialistReport.js";

describe("specialistReportSchema", () => {
  it("rejects findings status without a finding", () => {
    const parsed = specialistReportSchema.safeParse({
      status: "findings",
      findings: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects no_findings status with a finding", () => {
    const parsed = specialistReportSchema.safeParse({
      status: "no_findings",
      findings: [
        {
          severity: "P2",
          file: "src/app.ts",
          startLine: 1,
          endLine: 1,
          title: "Handle the failed request",
          detail: "The request failure reaches this path without recovery.",
          fixPrompt: "Handle the failure before returning.",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects more than 20 findings", () => {
    const findings = Array.from({ length: 21 }, (_, index) => ({
      severity: "P2",
      file: "src/app.ts",
      startLine: index + 1,
      endLine: index + 1,
      title: `Handle failed request ${index + 1}`,
      detail: "The request failure reaches this path without recovery.",
      fixPrompt: "Handle the failure before returning.",
    }));

    const parsed = specialistReportSchema.safeParse({ status: "findings", findings });

    expect(parsed.success).toBe(false);
  });
});
