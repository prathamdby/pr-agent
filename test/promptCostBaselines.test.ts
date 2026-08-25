import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toJsonSchema } from "@valibot/to-json-schema";
import { buildContext7Tools } from "../src/agent/tools/context7Tools.js";
import { buildLocalWorkspaceTools } from "../src/agent/tools/localWorkspaceTools.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
} from "../src/review/publish/submitReviewTool.js";
import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";
import { buildReviewRunUserContent } from "../src/review/prompts/reviewUserMessage.js";
import { createReviewPayloadSchema } from "../src/review/reviewSchema.js";
import {
  assertPromptCostWithinBudget,
  measurePromptCost,
  stableJson,
  type PromptCost,
} from "./helpers/promptCost.js";
import { isRecord } from "../src/util/typeGuards.js";
import { makeTestConfig } from "./helpers/config.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

function reviewPrSurface() {
  return createFakePrSurface({ owner: "octo", repo: "hello", prNumber: 42 }).surface;
}

type PromptSurface = {
  readonly name: string;
  readonly content: string;
  readonly budget: PromptCost;
};

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const REVIEW_PAYLOAD_FIELDS = [
  "prCharacter",
  "findings",
  "size",
  "relevantTests",
  "securityConcerns",
  "followUps",
] as const;
const LOCAL_WORKSPACE_TOOL_NAMES = [
  "getWorkspaceBlame",
  "getWorkspaceDiff",
  "listChangedFiles",
  "readWorkspaceFile",
  "resolveSymbol",
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
    const prompt = buildAutomatedSystemPrompt();
    expect(prompt).toContain("submit_findings_report");
    expect(prompt).toContain("no_findings");
    expect(prompt).toContain("Report only issues introduced or exposed by this PR");
    expect(prompt).toContain("Follow each local workspace tool's description");
    for (const severity of SEVERITIES) {
      expect(prompt).toContain(severity);
    }
  });

  it("keeps review user content bounded and structured", () => {
    const content = representativeReviewUserContent();
    expect(content).toContain("Target repository: octo/hello");
    expect(content).toContain("Head commit SHA: abc123");
    expect(content).toContain("submitReview exactly once");
  });

  it("keeps structured review schema top-level fields required", () => {
    const jsonSchema = toJsonSchema(createReviewPayloadSchema(), { errorMode: "ignore" });
    const required = requiredFields(jsonSchema);
    expect(required.toSorted()).toEqual([...REVIEW_PAYLOAD_FIELDS].toSorted());
  });

  it("keeps submitReview tool contract stable", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      prSurface: reviewPrSurface(),
      ctx: {
        owner: "octo",
        repo: "hello",
        prNumber: 42,
        headSha: "abc123",
        hasDescriptionReviewMap: false,
      },
      state: createSubmitReviewState(),
    });
    expect(piTool.name).toBe("submitReview");
    expect(piTool.description).toContain("ReviewPayload");
    expect(piTool.description).toContain("tool schema");
    expect(piTool.description).not.toContain("Minimal valid example");
    expect(requiredFields(piTool.parameters).toSorted()).toEqual(
      [...REVIEW_PAYLOAD_FIELDS].toSorted(),
    );
  });

  it("reduces static submitReview tool surface versus the prior field-list description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      prSurface: reviewPrSurface(),
      ctx: {
        owner: "octo",
        repo: "hello",
        prNumber: 42,
        headSha: "abc123",
        hasDescriptionReviewMap: false,
      },
      state: createSubmitReviewState(),
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
  const submitReviewTool = buildSubmitReviewTool({
    cfg,
    prSurface: reviewPrSurface(),
    ctx: {
      owner: "octo",
      repo: "hello",
      prNumber: 42,
      headSha: "abc123",
      hasDescriptionReviewMap: false,
    },
    state: createSubmitReviewState(),
  }).piTool;
  return [
    {
      name: "general review system prompt",
      content: buildAutomatedSystemPrompt(),
      budget: { bytes: 13_000, characters: 13_000, estimatedTokens: 3_250 },
    },
    {
      name: "representative review user content",
      content: representativeReviewUserContent(),
      budget: { bytes: 400, characters: 400, estimatedTokens: 100 },
    },
    {
      name: "local workspace tool definitions",
      content: stableJson(localWorkspaceTools),
      // Enriched investigation-protocol descriptions (issue #363); resolveSymbol added for symbol index.
      budget: { bytes: 3_100, characters: 3_100, estimatedTokens: 775 },
    },
    {
      name: "Context7 tool definitions",
      content: stableJson(context7Tools),
      // Shared no-exfiltration descriptions are part of the tool contract.
      budget: { bytes: 2_000, characters: 2_000, estimatedTokens: 500 },
    },
    {
      name: "structured review submission tool",
      content: stableJson(submitReviewTool),
      budget: { bytes: 2_050, characters: 2_050, estimatedTokens: 513 },
    },
  ];
}

function representativeReviewUserContent(): string {
  return buildReviewRunUserContent({
    owner: "octo",
    repo: "hello",
    prNumber: 42,
    headSha: "abc123",
    userSupplement: "Focus on the billing retry path.",
    trustedContext: '<context trusted="server">\nChanged files: src/billing.ts\n</context>',
  });
}

function requiredFields(schema: unknown): string[] {
  if (!isObjectSchema(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((field): field is string => typeof field === "string");
}

function isObjectSchema(value: unknown): value is { readonly required?: readonly unknown[] } {
  return isRecord(value);
}
