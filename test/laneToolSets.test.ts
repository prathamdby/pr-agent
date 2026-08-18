import { describe, expect, it } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { buildAskRunSetup } from "../src/agent/ask/askRunSetup.js";
import { ASK_TOOL_NAMES } from "../src/agent/ask/askToolSet.js";
import { buildAskSystemPrompt } from "../src/agent/ask/askPrompt.js";
import { buildDescriptionRunSetup } from "../src/agent/description/descriptionRunSetup.js";
import { DESCRIPTION_TOOL_NAMES } from "../src/agent/description/descriptionToolSet.js";
import { descriptionSystemPrompt } from "../src/agent/description/descriptionSystemPrompt.js";
import { triageSystemPrompt } from "../src/agent/triage/triagePrompt.js";
import { TRIAGE_TOOL_NAMES } from "../src/agent/triage/triageToolSet.js";
import { buildTriageRunSetup } from "../src/agent/triage/triageRunSetup.js";
import { verificationSystemPrompt } from "../src/agent/verification/verificationPrompt.js";
import { VERIFICATION_TOOL_NAMES } from "../src/agent/verification/verificationToolSet.js";
import { buildVerificationRunSetup } from "../src/agent/verification/verificationRunSetup.js";
import { assembleNamedTools, formatUnknownToolError } from "../src/agent/tools/laneToolContract.js";
import { AppError } from "../src/errors/appError.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { orchestratorSystemPrompt } from "../src/review/orchestrator/prompts/orchestratorPrompts.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";
import { REVIEW_SPECIALIST_TOOL_NAMES } from "../src/review/orchestrator/specialistToolSet.js";
import {
  buildSpecialistSessionTools,
  buildSubmitFindingsReportPiTool,
} from "../src/review/orchestrator/specialistTools.js";
import { REVIEW_ORCHESTRATOR_TOOL_NAMES } from "../src/review/run/reviewToolSet.js";
import { buildReviewRunSetup } from "../src/review/run/reviewRunSetup.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const REMOVED = ["searchCodeIndex", "resolveSymbol", "getWorkspaceBlame", "submitReview"] as const;
const WRITE_TOOLS = ["editWorkspaceFile", "createWorkspaceFile", "commitFix"] as const;

function stubTool(name: string): PiTool {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

function stubCatalog(names: readonly string[]) {
  return {
    piTools: names.map(stubTool),
    executors: Object.fromEntries(names.map((name) => [name, async () => ({ ok: true })])),
  };
}

function namesOf(piTools: readonly { name: string }[]): string[] {
  return piTools.map((tool) => tool.name);
}

describe("lane tool sets", () => {
  it("assembles each declared lane list in order", () => {
    const lanes = [
      REVIEW_ORCHESTRATOR_TOOL_NAMES,
      REVIEW_SPECIALIST_TOOL_NAMES,
      ASK_TOOL_NAMES,
      DESCRIPTION_TOOL_NAMES,
      TRIAGE_TOOL_NAMES,
      VERIFICATION_TOOL_NAMES,
    ];
    for (const declared of lanes) {
      const assembled = assembleNamedTools(declared, [stubCatalog(declared)]);
      expect(namesOf(assembled.piTools)).toEqual([...declared]);
      for (const removed of REMOVED) {
        expect(assembled.piTools.map((tool) => tool.name)).not.toContain(removed);
      }
    }
  });

  it("review setup keeps Context7 and drops the cut tools", () => {
    const setup = buildReviewRunSetup({
      cfg: makeTestConfig(),
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      workspace: mockLocalPrWorkspace(),
    });
    const names = namesOf(setup.workspaceTools.piTools);
    expect(names).toEqual([
      "listChangedFiles",
      "readWorkspaceFile",
      "searchWorkspace",
      "getWorkspaceDiff",
      "resolveLibraryId",
      "getLibraryDocs",
    ]);
    for (const removed of REMOVED) {
      expect(names).not.toContain(removed);
    }
    for (const write of WRITE_TOOLS) {
      expect(names).not.toContain(write);
    }
  });

  it("specialist session tools match the specialist allowlist", () => {
    const workspace = stubCatalog(
      REVIEW_SPECIALIST_TOOL_NAMES.filter((name) => name !== "submit_findings_report"),
    );
    const assembled = buildSpecialistSessionTools(workspace, {
      piTool: buildSubmitFindingsReportPiTool(),
      executor: async () => ({ accepted: true }),
    });
    expect(namesOf(assembled.piTools)).toEqual([...REVIEW_SPECIALIST_TOOL_NAMES]);
    expect(assembled.piTools.map((tool) => tool.name)).toContain("resolveLibraryId");
    expect(assembled.piTools.map((tool) => tool.name)).toContain("getLibraryDocs");
    for (const write of WRITE_TOOLS) {
      expect(assembled.piTools.map((tool) => tool.name)).not.toContain(write);
    }
  });

  it("ask, description, triage, and verification setups match their allowlists", () => {
    const cfg = makeTestConfig();
    const workspace = mockLocalPrWorkspace();
    const prSurface = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface;

    const ask = buildAskRunSetup({
      cfg,
      prSurface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      question: "what changed?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      workspace,
    });
    expect(namesOf(ask.bundle.piTools)).toEqual([...ASK_TOOL_NAMES]);
    expect(ask.bundle.piTools.map((tool) => tool.name)).toContain("resolveLibraryId");
    expect(ask.bundle.piTools.map((tool) => tool.name)).toContain("getLibraryDocs");

    const description = buildDescriptionRunSetup({
      cfg,
      prSurface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      workspace,
    });
    expect(namesOf(description.piTools)).toEqual([...DESCRIPTION_TOOL_NAMES]);
    expect(description.piTools.map((tool) => tool.name)).not.toContain("resolveLibraryId");

    const checkout: WritablePrCheckout = {
      dir: "/tmp/triage-lane",
      headRef: "feature",
      baseSha: "a".repeat(40),
      commit: async () => ({ sha: "b".repeat(40), diff: "" }),
      push: async () => undefined,
      listCommittedShas: () => [],
      listCommittedDetails: () => [],
    };
    const triage = buildTriageRunSetup({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout,
      inventory: [],
    });
    expect(namesOf(triage.piTools)).toEqual([...TRIAGE_TOOL_NAMES]);
    for (const write of WRITE_TOOLS) {
      expect(triage.piTools.map((tool) => tool.name)).toContain(write);
    }

    const verification = buildVerificationRunSetup({
      cfg,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      rootDir: "/tmp/verification-lane",
      inventory: [],
      pushedCommits: [],
    });
    expect(namesOf(verification.piTools)).toEqual([...VERIFICATION_TOOL_NAMES]);
    for (const write of WRITE_TOOLS) {
      expect(verification.piTools.map((tool) => tool.name)).not.toContain(write);
    }
  });

  it("throws when a catalog name lacks a piTool or executor", () => {
    const names = ["readWorkspaceFile", "missingTool"] as const;
    const catalogA = {
      piTools: [stubTool("readWorkspaceFile")],
      executors: {},
    };
    const catalogB = stubCatalog(["getWorkspaceDiff"]);
    expect(() => assembleNamedTools(names, [catalogA, catalogB])).toThrow(AppError);
    try {
      assembleNamedTools(names, [catalogA, catalogB]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "provider.missing_tool_executor",
        message: formatUnknownToolError("readWorkspaceFile", names),
        context: { toolName: "readWorkspaceFile", validTools: [...names] },
      });
    }

    const missing = stubCatalog(["readWorkspaceFile"]);
    expect(() => assembleNamedTools(names, [missing])).toThrow(AppError);
    try {
      assembleNamedTools(names, [missing]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "provider.missing_tool_executor",
        message: formatUnknownToolError("missingTool", names),
        context: { toolName: "missingTool", validTools: [...names] },
      });
    }
  });

  it("unknown-tool errors list the lane's valid names", () => {
    const message = formatUnknownToolError("Glob", ASK_TOOL_NAMES);
    for (const name of ASK_TOOL_NAMES) {
      expect(message).toContain(name);
    }
    expect(message).toMatch(/^No executor registered for tool Glob\. Valid tools:/);
    expect(message).not.toMatch(/do not invent/i);
  });

  it("each lane prompt contains every declared tool name", () => {
    const prompts: Array<{ prompt: string; names: readonly string[] }> = [
      { prompt: orchestratorSystemPrompt, names: REVIEW_ORCHESTRATOR_TOOL_NAMES },
      { prompt: specialistSystemPrompt("correctness"), names: REVIEW_SPECIALIST_TOOL_NAMES },
      { prompt: buildAskSystemPrompt(), names: ASK_TOOL_NAMES },
      { prompt: descriptionSystemPrompt, names: DESCRIPTION_TOOL_NAMES },
      { prompt: triageSystemPrompt, names: TRIAGE_TOOL_NAMES },
      { prompt: verificationSystemPrompt, names: VERIFICATION_TOOL_NAMES },
    ];
    for (const { prompt, names } of prompts) {
      for (const name of names) {
        expect(prompt).toContain(name);
      }
      expect(prompt).toMatch(/Available tools:/);
      expect(prompt).not.toMatch(/do not invent tools/i);
    }
  });
});
