import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../src/agent/prompts/securityPrompt.js";
import { buildCursorPrompt } from "../src/agent/providers/cursor/promptBuilder.js";
import { buildContext7Tools } from "../src/agent/tools/context7Tools.js";
import { buildLocalWorkspaceTools } from "../src/agent/tools/localWorkspaceTools.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
} from "../src/review/publish/submitReviewTool.js";
import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";
import { buildReviewRunUserContent } from "../src/review/prompts/reviewUserMessage.js";
import { createReviewPayloadSchema, type ReviewMode } from "../src/review/reviewSchema.js";
import {
  assertPromptCostWithinBudget,
  stableJson,
  type PromptCostBudget,
} from "./helpers/promptCost.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

type PromptSurface = {
  readonly name: string;
  readonly content: string;
  readonly budget: PromptCostBudget;
};

const REVIEW_MODES = ["review", "review-security", "review-quality", "review-tests"] as const;
const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const REVIEW_PAYLOAD_FIELDS = [
  "prCharacter",
  "findings",
  "estimatedEffort",
  "relevantTests",
  "securityConcerns",
  "followUps",
] as const;
const LOCAL_WORKSPACE_TOOL_NAMES = [
  "getWorkspaceBlame",
  "getWorkspaceDiff",
  "listChangedFiles",
  "readWorkspaceFile",
  "searchWorkspace",
] as const;
const CONTEXT7_TOOL_NAMES = ["getLibraryDocs", "resolveLibraryId"] as const;

const cfg = makeTestConfig();

describe("prompt cost baselines", () => {
  it("keeps prompt and tool surfaces within explicit budgets", () => {
    for (const surface of promptSurfaces()) {
      assertPromptCostWithinBudget(surface);
    }
  });

  it("keeps review prompt behavior-critical phrases", () => {
    for (const [name, prompt] of reviewLensPrompts()) {
      expect(prompt, `${name} should require one submitReview call`).toContain(
        "submitReview exactly once",
      );
      for (const severity of SEVERITIES) {
        expect(prompt, `${name} should keep ${severity} severity guidance`).toContain(severity);
      }
    }
  });

  it("keeps review user content mode instructions bounded and structured", () => {
    for (const mode of REVIEW_MODES) {
      const content = representativeReviewUserContent(mode);
      expect(content).toContain("Target repository: octo/hello");
      expect(content).toContain("Head commit SHA: abc123");
      expect(content).toContain("submitReview exactly once");
    }
  });

  it("keeps structured review schema top-level fields required", () => {
    const jsonSchema = z.toJSONSchema(createReviewPayloadSchema(), { unrepresentable: "any" });
    const required = requiredFields(jsonSchema);
    expect(required.toSorted()).toEqual([...REVIEW_PAYLOAD_FIELDS].toSorted());
  });

  it("keeps submitReview tool contract stable", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "token",
      ctx: { owner: "octo", repo: "hello", prNumber: 42, headSha: "abc123" },
      state: createSubmitReviewState(),
    });
    expect(piTool.name).toBe("submitReview");
    expect(piTool.description).toContain("ReviewPayload");
    expect(requiredFields(piTool.parameters).toSorted()).toEqual(
      [...REVIEW_PAYLOAD_FIELDS].toSorted(),
    );
  });

  it("keeps investigation tool names stable", () => {
    const { piTools: localTools } = buildLocalWorkspaceTools(mockLocalPrWorkspace(), {
      maxFileBytes: 100_000,
      searchMaxFiles: 100,
      searchMaxTotalBytes: 1_000_000,
    });
    const { piTools: context7Tools } = buildContext7Tools({ apiKey: "" });

    expect(localTools.map((tool) => tool.name).toSorted()).toEqual([...LOCAL_WORKSPACE_TOOL_NAMES]);
    expect(context7Tools.map((tool) => tool.name).toSorted()).toEqual([...CONTEXT7_TOOL_NAMES]);
  });

  it("keeps stable JSON compatible with toJSON values", () => {
    expect(stableJson({ z: 1, at: new Date("2026-06-21T00:00:00.000Z") })).toBe(
      '{"at":"2026-06-21T00:00:00.000Z","z":1}',
    );
  });
});

function promptSurfaces(): PromptSurface[] {
  const localWorkspaceTools = buildLocalWorkspaceTools(mockLocalPrWorkspace(), {
    maxFileBytes: 100_000,
    searchMaxFiles: 100,
    searchMaxTotalBytes: 1_000_000,
  }).piTools;
  const context7Tools = buildContext7Tools({ apiKey: "" }).piTools;
  const submitReviewTool = buildSubmitReviewTool({
    cfg,
    token: "token",
    ctx: { owner: "octo", repo: "hello", prNumber: 42, headSha: "abc123" },
    state: createSubmitReviewState(),
  }).piTool;
  const cursorPrompt = buildCursorPrompt(representativeCursorContext()).text;

  return [
    {
      name: "general review system prompt",
      content: buildAutomatedSystemPrompt(),
      budget: { bytes: 10_600, characters: 10_600, estimatedTokens: 2_650 },
    },
    {
      name: "security review system prompt",
      content: automatedSecuritySystemPrompt,
      budget: { bytes: 12_100, characters: 12_100, estimatedTokens: 3_025 },
    },
    {
      name: "quality review system prompt",
      content: automatedQualitySystemPrompt,
      budget: { bytes: 10_050, characters: 10_000, estimatedTokens: 2_500 },
    },
    {
      name: "tests review system prompt",
      content: automatedReviewTestsSystemPrompt,
      budget: { bytes: 8_450, characters: 8_400, estimatedTokens: 2_100 },
    },
    {
      name: "representative review user content",
      content: representativeReviewUserContent("review"),
      budget: { bytes: 400, characters: 400, estimatedTokens: 100 },
    },
    {
      name: "local workspace tool definitions",
      content: stableJson(localWorkspaceTools),
      budget: { bytes: 1_800, characters: 1_800, estimatedTokens: 450 },
    },
    {
      name: "Context7 tool definitions",
      content: stableJson(context7Tools),
      budget: { bytes: 1_450, characters: 1_450, estimatedTokens: 365 },
    },
    {
      name: "structured review submission tool",
      content: stableJson(submitReviewTool),
      budget: { bytes: 2_500, characters: 2_500, estimatedTokens: 625 },
    },
    {
      name: "representative Cursor prompt",
      content: cursorPrompt,
      budget: { bytes: 11_000, characters: 11_000, estimatedTokens: 2_750 },
    },
  ];
}

function reviewLensPrompts(): ReadonlyArray<readonly [string, string]> {
  return [
    ["general review system prompt", buildAutomatedSystemPrompt()],
    ["security review system prompt", automatedSecuritySystemPrompt],
    ["quality review system prompt", automatedQualitySystemPrompt],
    ["tests review system prompt", automatedReviewTestsSystemPrompt],
  ];
}

function representativeReviewUserContent(reviewMode: ReviewMode): string {
  return buildReviewRunUserContent({
    owner: "octo",
    repo: "hello",
    prNumber: 42,
    headSha: "abc123",
    reviewMode,
    userSupplement: "Focus on the billing retry path.",
    trustedContext: '<context trusted="server">\nChanged files: src/billing.ts\n</context>',
  });
}

function representativeCursorContext(): Context {
  return {
    systemPrompt: buildAutomatedSystemPrompt(),
    messages: [
      {
        role: "user",
        content: representativeReviewUserContent("review"),
        timestamp: 1,
      },
    ],
  };
}

function requiredFields(schema: unknown): string[] {
  if (!isObjectSchema(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((field): field is string => typeof field === "string");
}

function isObjectSchema(value: unknown): value is { readonly required?: readonly unknown[] } {
  return typeof value === "object" && value != null;
}
