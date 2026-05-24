import { describe, expect, it } from "vitest";
import { evaluateTrivialChangeExemption, isDocsOnlyPath } from "../src/agent/reviewChangeGate.js";

describe("isDocsOnlyPath", () => {
  it("accepts markdown and docs paths", () => {
    expect(isDocsOnlyPath("README.md")).toBe(true);
    expect(isDocsOnlyPath("docs/configuration.md")).toBe(true);
    expect(isDocsOnlyPath("CHANGELOG.md")).toBe(true);
    expect(isDocsOnlyPath("LICENSE")).toBe(true);
    expect(isDocsOnlyPath(".github/CONTRIBUTING.md")).toBe(true);
  });

  it("rejects code and config paths", () => {
    expect(isDocsOnlyPath(".env.example")).toBe(false);
    expect(isDocsOnlyPath("src/index.ts")).toBe(false);
    expect(isDocsOnlyPath(".github/workflows/ci.yml")).toBe(false);
    expect(isDocsOnlyPath("package.json")).toBe(false);
  });

  it("rejects readme/license/changelog basename prefix on code files", () => {
    expect(isDocsOnlyPath("README.ts")).toBe(false);
    expect(isDocsOnlyPath("license-check.sh")).toBe(false);
    expect(isDocsOnlyPath("changelog-generator.js")).toBe(false);
  });
});

describe("evaluateTrivialChangeExemption", () => {
  it("exempts when all files are docs-only", () => {
    expect(
      evaluateTrivialChangeExemption({
        files: [{ filename: "README.md" }, { filename: "docs/guide.md" }],
        truncated: false,
      }),
    ).toEqual({ exempt: true });
  });

  it("rejects truncated change sets", () => {
    expect(
      evaluateTrivialChangeExemption({
        files: [{ filename: "README.md" }],
        truncated: true,
      }),
    ).toEqual({ exempt: false, reason: "truncated" });
  });

  it("rejects mixed docs and code", () => {
    expect(
      evaluateTrivialChangeExemption({
        files: [{ filename: "README.md" }, { filename: "src/main.ts" }],
        truncated: false,
      }).exempt,
    ).toBe(false);
  });
});
