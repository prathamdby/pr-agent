import { describe, expect, it } from "vitest";
import { measurePromptCost } from "./helpers/promptCost.js";
import { PROMPT_COST_EVAL_FIXTURES } from "./promptCostEval/fixtures.js";
import {
  buildEvalSurfaces,
  compareCandidate,
  formatReportJson,
  runPromptCostEval,
} from "./promptCostEval/harness.js";
import {
  buildFixtureEvidenceInvariants,
  buildSystemPromptInvariants,
  evaluateInvariants,
} from "./promptCostEval/invariants.js";
import {
  baselineTransform,
  compactStaticTransform,
  compactToolResultTransform,
  customShorthandTransform,
  EVAL_CANDIDATE_TRANSFORMS,
  lossyStripTransform,
} from "./promptCostEval/transforms.js";

describe("prompt cost compression eval harness", () => {
  it("covers representative offline fixtures for every review lens", () => {
    const lenses = new Set(PROMPT_COST_EVAL_FIXTURES.map((f) => f.lens));
    expect(lenses.has("review")).toBe(true);
    expect(lenses.has("review-security")).toBe(true);
    expect(lenses.has("review-quality")).toBe(true);
    expect(lenses.has("review-tests")).toBe(true);

    const ids = PROMPT_COST_EVAL_FIXTURES.map((f) => f.id);
    expect(ids).toContain("correctness-null-deref");
    expect(ids).toContain("security-sql-interpolation");
    expect(ids).toContain("false-positive-intentional-any");
    expect(ids).toContain("quality-1k-line-growth");
    expect(ids).toContain("tests-untested-error-path");
    expect(ids).toContain("large-truncated-context");

    for (const fixture of PROMPT_COST_EVAL_FIXTURES) {
      expect(fixture.evidenceLabels.length).toBeGreaterThan(0);
      expect(fixture.changedFiles.length).toBeGreaterThan(0);
      expect(fixture.diffContent.length).toBeGreaterThan(0);
      expect(fixture.diffContent).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(fixture.diffContent).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
    }
  });

  it("builds baseline prompt surfaces through production prompt builders", () => {
    const surfaces = buildEvalSurfaces();
    const system = surfaces.filter((s) => s.kind === "system-prompt");
    expect(new Set(system.map((s) => s.lens))).toEqual(
      new Set(["review", "review-quality", "review-security", "review-tests"]),
    );
    for (const surface of system) {
      expect(surface.content).toContain("submitReview exactly once");
      expect(surface.content).toContain("ReviewPayload");
      for (const severity of ["P0", "P1", "P2", "P3"] as const) {
        expect(surface.content).toContain(severity);
      }
    }
  });

  it("compares baseline and candidate formats numerically", () => {
    const { comparisons, report } = runPromptCostEval();
    expect(comparisons.length).toBeGreaterThan(0);
    expect(report.tokenizer).toBe("char/4-estimate");

    for (const row of comparisons) {
      expect(row.baselineBytes).toBeGreaterThan(0);
      expect(row.baselineEstimatedTokens).toBeGreaterThan(0);
      expect(row.candidateBytes).toBeGreaterThanOrEqual(0);
      expect(row.candidateEstimatedTokens).toBeGreaterThanOrEqual(0);
      expect(typeof row.percentReduction).toBe("number");
      expect(Number.isFinite(row.percentReduction)).toBe(true);
    }

    const baselineRows = comparisons.filter((c) => c.candidateId === "baseline");
    expect(baselineRows.length).toBeGreaterThan(0);
    for (const row of baselineRows) {
      expect(row.percentReduction).toBe(0);
      expect(row.candidateBytes).toBe(row.baselineBytes);
      expect(row.invariantsPassed).toBe(true);
    }
  });

  it("keeps required contract markers under non-lossy candidates", () => {
    const surfaces = buildEvalSurfaces().filter((s) => s.kind === "system-prompt");
    const safeTransforms = [
      baselineTransform,
      compactStaticTransform,
      compactToolResultTransform,
      customShorthandTransform,
    ];

    for (const surface of surfaces) {
      const baselineCost = measurePromptCost(surface.content);
      for (const transform of safeTransforms) {
        const row = compareCandidate({ surface, transform, baselineCost });
        expect(
          row.invariantsPassed,
          `${surface.name}/${transform.id}: ${JSON.stringify(row.invariantFailures)}`,
        ).toBe(true);
      }
    }
  });

  it("rejects candidates that remove required fields, severity labels, or evidence", () => {
    const surfaces = buildEvalSurfaces();
    const system = surfaces.find((s) => s.name === "system:review");
    expect(system).toBeDefined();
    if (!system) return;

    const baselineCost = measurePromptCost(system.content);
    const lossy = compareCandidate({
      surface: system,
      transform: lossyStripTransform,
      baselineCost,
    });
    expect(lossy.invariantsPassed).toBe(false);
    const kinds = new Set(lossy.invariantFailures.map((f) => f.kind));
    expect(kinds.has("structured-submission") || kinds.has("payload-field")).toBe(true);
    expect(kinds.has("severity")).toBe(true);

    const fixtureSurface = surfaces.find((s) => s.name === "fixture:correctness-null-deref");
    expect(fixtureSurface).toBeDefined();
    if (!fixtureSurface) return;
    const fixtureBaseline = measurePromptCost(fixtureSurface.content);
    const lossyFixture = compareCandidate({
      surface: fixtureSurface,
      transform: lossyStripTransform,
      baselineCost: fixtureBaseline,
    });
    expect(lossyFixture.invariantsPassed).toBe(false);
    expect(lossyFixture.invariantFailures.some((f) => f.kind === "fixture-evidence")).toBe(true);
  });

  it("preserves fixture evidence labels under compact transforms", () => {
    for (const fixture of PROMPT_COST_EVAL_FIXTURES) {
      const text = [fixture.supportingContext, fixture.diffContent].join("\n\n");
      for (const transform of [
        compactStaticTransform,
        compactToolResultTransform,
        customShorthandTransform,
      ]) {
        const out = transform.apply(text);
        const inv = evaluateInvariants(out, buildFixtureEvidenceInvariants(fixture.evidenceLabels));
        expect(
          inv.allPassed,
          `${fixture.id}/${transform.id}: ${JSON.stringify(inv.failures)}`,
        ).toBe(true);
      }
    }
  });

  it("emits a machine-readable comparison report shape", async () => {
    const { report } = runPromptCostEval({
      transforms: EVAL_CANDIDATE_TRANSFORMS,
      surfaces: buildEvalSurfaces().filter((s) => s.kind === "system-prompt"),
    });
    const json = formatReportJson(report);
    const parsed = JSON.parse(json) as {
      tokenizer: string;
      comparisons: Array<{
        surfaceName: string;
        candidateId: string;
        baselineBytes: number;
        baselineEstimatedTokens: number;
        candidateBytes: number;
        candidateEstimatedTokens: number;
        percentReduction: number;
        invariantsPassed: boolean;
      }>;
    };
    expect(parsed.tokenizer).toBe("char/4-estimate");
    expect(parsed.comparisons.length).toBeGreaterThan(0);
    for (const row of parsed.comparisons) {
      expect(row).toEqual(
        expect.objectContaining({
          surfaceName: expect.any(String),
          candidateId: expect.any(String),
          baselineBytes: expect.any(Number),
          baselineEstimatedTokens: expect.any(Number),
          candidateBytes: expect.any(Number),
          candidateEstimatedTokens: expect.any(Number),
          percentReduction: expect.any(Number),
          invariantsPassed: expect.any(Boolean),
        }),
      );
    }

    if (process.env.PROMPT_COST_EVAL_OUT) {
      const { writeFileSync } = await import("node:fs");
      const full = runPromptCostEval();
      writeFileSync(
        process.env.PROMPT_COST_EVAL_OUT,
        formatReportJson({
          ...full.report,
          generatedAt: new Date().toISOString(),
        }),
        "utf8",
      );
    }
  });

  it("keeps custom shorthand transforms test-only (not imported from src/)", async () => {
    const srcImport = await import("../src/review/prompts/reviewSystemPrompt.js");
    expect(srcImport).not.toHaveProperty("customShorthandPrototype");
    expect(srcImport).not.toHaveProperty("compactStaticFormatting");

    const checks = buildSystemPromptInvariants({ lens: "review" });
    expect(checks.some((c) => c.kind === "structured-submission")).toBe(true);
    expect(checks.some((c) => c.kind === "severity")).toBe(true);
    expect(checks.some((c) => c.kind === "payload-field")).toBe(true);
  });

  it("uses the shared char/4 estimate and does not require a tokenizer dependency", () => {
    const sample = "abcd".repeat(25);
    const cost = measurePromptCost(sample);
    expect(cost.characters).toBe(100);
    expect(cost.estimatedTokens).toBe(25);
    expect(EVAL_CANDIDATE_TRANSFORMS.every((t) => typeof t.apply === "function")).toBe(true);
  });
});
