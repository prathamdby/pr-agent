/** Offline prompt-cost eval: pure string transforms, no network/LLM/Postgres. */

import { automatedQualitySystemPrompt } from "../../src/agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../../src/agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../../src/agent/prompts/securityPrompt.js";
import { wrapTrustedContext } from "../../src/agent/prompts/promptBlocks.js";
import { buildAutomatedSystemPrompt } from "../../src/review/prompts/reviewSystemPrompt.js";
import { buildReviewRunUserContent } from "../../src/review/prompts/reviewUserMessage.js";
import type { ReviewMode } from "../../src/review/reviewSchema.js";
import { measurePromptCost, type PromptCost } from "../helpers/promptCost.js";
import {
  PROMPT_COST_EVAL_FIXTURES,
  type PromptCostEvalFixture,
  type ReviewLens,
} from "./fixtures.js";
import {
  buildFixtureEvidenceInvariants,
  buildSystemPromptInvariants,
  evaluateInvariants,
  type InvariantResult,
} from "./invariants.js";
import {
  EVAL_CANDIDATE_TRANSFORMS,
  type PromptCostCandidateId,
  type PromptCostTransform,
} from "./transforms.js";

export type PromptSurfaceKind = "system-prompt" | "user-content" | "fixture-evidence";

export type PromptSurface = {
  readonly name: string;
  readonly kind: PromptSurfaceKind;
  readonly lens?: ReviewLens;
  readonly fixtureId?: string;
  readonly content: string;
};

export type CandidateComparison = {
  readonly surfaceName: string;
  readonly candidateId: PromptCostCandidateId;
  readonly baselineBytes: number;
  readonly baselineEstimatedTokens: number;
  readonly candidateBytes: number;
  readonly candidateEstimatedTokens: number;
  /** Percent reduction vs baseline (positive = smaller). */
  readonly percentReduction: number;
  readonly invariantsPassed: boolean;
  readonly invariantFailures: readonly InvariantResult[];
};

export type PromptCostEvalReport = {
  readonly generatedAt: string;
  readonly tokenizer: "char/4-estimate";
  readonly note: string;
  readonly comparisons: readonly CandidateComparison[];
};

function systemPromptForLens(lens: ReviewLens): string {
  switch (lens) {
    case "review":
      return buildAutomatedSystemPrompt();
    case "review-security":
      return automatedSecuritySystemPrompt;
    case "review-quality":
      return automatedQualitySystemPrompt;
    case "review-tests":
      return automatedReviewTestsSystemPrompt;
  }
  const exhaustive: never = lens;
  return exhaustive;
}

function fixtureUserContent(fixture: PromptCostEvalFixture): string {
  const trusted = wrapTrustedContext([
    fixture.supportingContext,
    "",
    "Diff excerpt:",
    fixture.diffContent,
  ]);
  return buildReviewRunUserContent({
    owner: "octo",
    repo: "hello",
    prNumber: 42,
    headSha: "abc123def",
    reviewMode: fixture.lens as ReviewMode,
    userSupplement: `Fixture ${fixture.id}: ${fixture.title}`,
    trustedContext: trusted,
  });
}

/** Build the prompt surfaces the offline eval compares. */
export function buildEvalSurfaces(): PromptSurface[] {
  const surfaces: PromptSurface[] = [];

  const lenses: ReviewLens[] = ["review", "review-security", "review-quality", "review-tests"];
  for (const lens of lenses) {
    surfaces.push({
      name: `system:${lens}`,
      kind: "system-prompt",
      lens,
      content: systemPromptForLens(lens),
    });
  }

  for (const fixture of PROMPT_COST_EVAL_FIXTURES) {
    const userContent = fixtureUserContent(fixture);
    surfaces.push({
      name: `user:${fixture.id}`,
      kind: "user-content",
      lens: fixture.lens,
      fixtureId: fixture.id,
      content: userContent,
    });
    // Fixture evidence surface: diff + supporting context only (what compression
    // must not strip of EVIDENCE:* labels).
    surfaces.push({
      name: `fixture:${fixture.id}`,
      kind: "fixture-evidence",
      lens: fixture.lens,
      fixtureId: fixture.id,
      content: [fixture.supportingContext, fixture.diffContent].join("\n\n"),
    });
  }

  return surfaces;
}

function invariantsForSurface(
  surface: PromptSurface,
): ReturnType<typeof buildSystemPromptInvariants> {
  if (surface.kind === "system-prompt") {
    return buildSystemPromptInvariants({ lens: surface.lens });
  }
  if (surface.kind === "fixture-evidence" && surface.fixtureId) {
    const fixture = PROMPT_COST_EVAL_FIXTURES.find((f) => f.id === surface.fixtureId);
    if (fixture) {
      return buildFixtureEvidenceInvariants(fixture.evidenceLabels);
    }
  }
  if (surface.kind === "user-content" && surface.fixtureId) {
    const fixture = PROMPT_COST_EVAL_FIXTURES.find((f) => f.id === surface.fixtureId);
    if (fixture) {
      return [
        ...buildFixtureEvidenceInvariants(fixture.evidenceLabels),
        {
          kind: "structured-submission" as const,
          label: "structured:submitReview exactly once",
          required: "submitReview exactly once",
        },
      ];
    }
  }
  return [];
}

export function compareCandidate(params: {
  readonly surface: PromptSurface;
  readonly transform: PromptCostTransform;
  readonly baselineCost: PromptCost;
}): CandidateComparison {
  const transformed = params.transform.apply(params.surface.content);
  const cost = measurePromptCost(transformed);
  const checks = invariantsForSurface(params.surface);
  const inv = evaluateInvariants(transformed, checks);
  const baselineBytes = params.baselineCost.bytes;
  const percentReduction =
    baselineBytes === 0 ? 0 : ((baselineBytes - cost.bytes) / baselineBytes) * 100;

  return {
    surfaceName: params.surface.name,
    candidateId: params.transform.id,
    baselineBytes,
    baselineEstimatedTokens: params.baselineCost.estimatedTokens,
    candidateBytes: cost.bytes,
    candidateEstimatedTokens: cost.estimatedTokens,
    percentReduction: Math.round(percentReduction * 100) / 100,
    invariantsPassed: inv.allPassed,
    invariantFailures: inv.failures,
  };
}

export function runPromptCostEval(params?: {
  readonly transforms?: readonly PromptCostTransform[];
  readonly surfaces?: readonly PromptSurface[];
}): {
  readonly report: PromptCostEvalReport;
  readonly comparisons: readonly CandidateComparison[];
} {
  const transforms = params?.transforms ?? EVAL_CANDIDATE_TRANSFORMS;
  const surfaces = params?.surfaces ?? buildEvalSurfaces();
  const comparisons: CandidateComparison[] = [];

  for (const surface of surfaces) {
    const baselineCost = measurePromptCost(surface.content);
    for (const transform of transforms) {
      comparisons.push(
        compareCandidate({
          surface,
          transform,
          baselineCost,
        }),
      );
    }
  }

  const report: PromptCostEvalReport = {
    generatedAt: new Date(0).toISOString(),
    tokenizer: "char/4-estimate",
    note:
      "Estimated tokens use characters/4 (model-agnostic). Not a provider tokenizer. " +
      "Custom shorthand is test-only and must not ship in production prompts.",
    comparisons,
  };

  return { report, comparisons };
}

export function formatReportJson(report: PromptCostEvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
