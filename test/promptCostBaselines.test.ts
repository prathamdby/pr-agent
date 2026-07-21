import type { Context } from "@earendil-works/pi-ai";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCursorPrompt } from "../src/agent/providers/cursor/promptBuilder.js";
import { buildContext7Tools } from "../src/agent/tools/context7Tools.js";
import { buildLocalWorkspaceTools } from "../src/agent/tools/localWorkspaceTools.js";
import {
  buildPublishSummaryTool,
  createSummaryCaptureState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import {
  buildOrchestratorSystemPrompt,
  renderReconInstruction,
} from "../src/review/orchestrator/prompts/orchestratorPrompts.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";
import { createReviewPayloadSchema } from "../src/review/reviewSchema.js";
import {
  assertPromptCostWithinBudget,
  measurePromptCost,
  stableJson,
  type PromptCostBudget,
} from "./helpers/promptCost.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

type PromptSurface = {
  readonly name: string;
  readonly content: string;
  readonly budget: PromptCostBudget;
};

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const REVIEW_PAYLOAD_FIELDS = [
  "prCharacter",
  "findings",
  "estimatedEffort",
  "relevantTests",
  "securityConcerns",
  "followUps",
] as const;
const SUMMARY_OVERVIEW_FIELDS = [
  "prCharacter",
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

describe("prompt cost baselines", () => {
  it("keeps prompt and tool surfaces within explicit budgets", () => {
    for (const surface of promptSurfaces()) {
      assertPromptCostWithinBudget(surface);
    }
  });

  it("keeps orchestrator and specialist behavior-critical phrases", () => {
    const orchestrator = buildOrchestratorSystemPrompt();
    expect(orchestrator).toContain("submit_specialist_brief");
    expect(orchestrator).toContain("publish_thread");
    expect(orchestrator).toContain("publish_summary");

    const correctness = specialistSystemPrompt("correctness");
    expect(correctness).toContain("submit_findings_report");
    expect(correctness).not.toContain("submitReview");
    for (const severity of SEVERITIES) {
      expect(correctness, `correctness should keep ${severity} severity guidance`).toContain(
        severity,
      );
    }
  });

  it("keeps recon user content instructions bounded and structured", () => {
    const content = representativeReconUserContent();
    expect(content).toContain("submit_specialist_brief");
    expect(content).toContain("billing retry");
    expect(content).toContain("src/billing.ts");
  });

  it("keeps structured review schema top-level fields required", () => {
    const jsonSchema = z.toJSONSchema(createReviewPayloadSchema(), { unrepresentable: "any" });
    const required = requiredFields(jsonSchema);
    expect(required.toSorted()).toEqual([...REVIEW_PAYLOAD_FIELDS].toSorted());
  });

  it("keeps publish_summary tool contract stable for synthesis", () => {
    const { piTool } = buildPublishSummaryTool({
      state: createSummaryCaptureState(),
    });
    expect(piTool.name).toBe("publish_summary");
    expect(piTool.description).toContain("overview");
    expect(requiredFields(piTool.parameters).toSorted()).toEqual(
      [...SUMMARY_OVERVIEW_FIELDS].toSorted(),
    );
  });

  it("keeps publish_summary tool surface within budget", () => {
    const { piTool } = buildPublishSummaryTool({
      state: createSummaryCaptureState(),
    });
    const bytes = measurePromptCost(stableJson(piTool)).bytes;
    expect(bytes).toBeLessThan(2_500);
    expect(bytes).toBeLessThan(2_050);
  });

  it("keeps investigation tool names stable", () => {
    const { piTools: localTools } = buildLocalWorkspaceTools(mockLocalPrWorkspace(), {
      limits: {
        maxFileBytes: 100_000,
        readResponseBytes: 128_000,
        diffResponseBytes: 256_000,
        searchMaxFiles: 100,
        searchMaxTotalBytes: 1_000_000,
      },
    });
    const { piTools: context7Tools } = buildContext7Tools({
      apiKey: "",
      maxResponseBytes: 64_000,
    });

    expect(localTools.map((tool) => tool.name).toSorted()).toEqual([...LOCAL_WORKSPACE_TOOL_NAMES]);
    expect(context7Tools.map((tool) => tool.name).toSorted()).toEqual([...CONTEXT7_TOOL_NAMES]);
  });

  it("keeps stable JSON compatible with toJSON values", () => {
    expect(stableJson({ z: 1, at: new Date("2026-06-21T00:00:00.000Z") })).toBe(
      '{"at":"2026-06-21T00:00:00.000Z","z":1}',
    );
  });

  it("keeps representative capped tool result shape stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-cost-tools-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/changed.ts"), `${"x".repeat(200)}\n`);
      const workspace = {
        ...mockLocalPrWorkspace(dir),
        changedFiles: [{ path: "src/changed.ts", status: "modified" as const }],
        changedFileByPath: new Map([
          ["src/changed.ts", { path: "src/changed.ts", status: "modified" as const }],
        ]),
        checkoutPaths: new Set(["src/changed.ts"]),
        isPathInCheckout: (path: string) => path === "src/changed.ts",
      };
      const { executors } = buildLocalWorkspaceTools(workspace, {
        limits: {
          maxFileBytes: 100_000,
          readResponseBytes: 32,
          diffResponseBytes: 32,
          searchMaxFiles: 100,
          searchMaxTotalBytes: 1_000_000,
        },
      });
      const out = (await executors.readWorkspaceFile?.({
        path: "src/changed.ts",
      })) as Record<string, unknown>;
      expect(out).toMatchObject({
        content: expect.any(String),
        path: "src/changed.ts",
        size: expect.any(Number),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        truncated: true,
        returnedBytes: expect.any(Number),
        truncationReason: "response byte budget exceeded",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function promptSurfaces(): PromptSurface[] {
  const localWorkspaceTools = buildLocalWorkspaceTools(mockLocalPrWorkspace(), {
    limits: {
      maxFileBytes: 100_000,
      readResponseBytes: 128_000,
      diffResponseBytes: 256_000,
      searchMaxFiles: 100,
      searchMaxTotalBytes: 1_000_000,
    },
  }).piTools;
  const context7Tools = buildContext7Tools({
    apiKey: "",
    maxResponseBytes: 64_000,
  }).piTools;
  const publishSummaryTool = buildPublishSummaryTool({
    state: createSummaryCaptureState(),
  }).piTool;
  const cursorPrompt = buildCursorPrompt(representativeCursorContext()).text;

  return [
    {
      name: "orchestrator system prompt",
      content: buildOrchestratorSystemPrompt(),
      budget: { bytes: 2_500, characters: 2_500, estimatedTokens: 625 },
    },
    {
      name: "correctness specialist system prompt",
      content: specialistSystemPrompt("correctness"),
      budget: { bytes: 14_000, characters: 14_000, estimatedTokens: 3_500 },
    },
    {
      name: "representative recon user content",
      content: representativeReconUserContent(),
      budget: { bytes: 800, characters: 800, estimatedTokens: 200 },
    },
    {
      name: "local workspace tool definitions",
      content: stableJson(localWorkspaceTools),
      budget: { bytes: 2_200, characters: 2_200, estimatedTokens: 550 },
    },
    {
      name: "Context7 tool definitions",
      content: stableJson(context7Tools),
      budget: { bytes: 1_500, characters: 1_500, estimatedTokens: 375 },
    },
    {
      name: "structured review submission tool",
      content: stableJson(publishSummaryTool),
      budget: { bytes: 2_050, characters: 2_050, estimatedTokens: 513 },
    },
    {
      name: "representative Cursor prompt",
      content: cursorPrompt,
      budget: { bytes: 16_000, characters: 16_000, estimatedTokens: 4_000 },
    },
  ];
}

function representativeReconUserContent(): string {
  return [
    renderReconInstruction({
      prTitle: "Fix billing retry",
      prBody: "Focus on the billing retry path.",
      changedFilesSummary: "src/billing.ts",
    }),
    '\n<context trusted="server">\nChanged files: src/billing.ts\n</context>\n',
  ].join("\n");
}

function representativeCursorContext(): Context {
  return {
    systemPrompt: specialistSystemPrompt("correctness"),
    messages: [
      {
        role: "user",
        content: representativeReconUserContent(),
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
