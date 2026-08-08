import { describe, expect, it } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../src/errors/appError.js";
import { SPECIALIST_IDS } from "../src/review/orchestrator/orchestratorTypes.js";
import {
  SUBMIT_FINDINGS_REPORT_NAME,
  buildSpecialistSessionTools,
  buildSubmitFindingsReportPiTool,
} from "../src/review/orchestrator/specialistTools.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";

function specialistToolDefinitionsJson(piTools: readonly PiTool[]): string {
  return JSON.stringify(
    piTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

describe("specialistTools", () => {
  it("builds identical tool definition JSON for every specialist id", () => {
    const workspacePiTools: PiTool[] = [
      {
        name: "readWorkspaceFile",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "searchCodeIndex",
        description: "Search index",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ];
    const workspaceTools = {
      piTools: workspacePiTools,
      executors: {
        readWorkspaceFile: async () => ({}),
        searchCodeIndex: async () => ({ unavailable: true }),
      },
    };

    const payloads = SPECIALIST_IDS.map((specialist) => {
      const submit = {
        piTool: buildSubmitFindingsReportPiTool(),
        executor: async () => ({ accepted: true, specialist }),
      };
      const tools = buildSpecialistSessionTools(workspaceTools, submit);
      return {
        specialist,
        systemPrompt: specialistSystemPrompt(specialist),
        toolJson: specialistToolDefinitionsJson(tools.piTools),
        toolNames: tools.piTools.map((tool) => tool.name),
      };
    });

    for (const row of payloads) {
      expect(row.toolNames.at(-1)).toBe(SUBMIT_FINDINGS_REPORT_NAME);
      expect(row.toolJson).toBe(payloads[0]?.toolJson);
    }

    const prompts = new Set(payloads.map((row) => row.systemPrompt));
    expect(prompts.size).toBe(SPECIALIST_IDS.length);
  });

  it("throws AppError when the submit tool name mismatches", () => {
    expect(() =>
      buildSpecialistSessionTools(
        { piTools: [], executors: {} },
        {
          piTool: {
            name: "wrong_tool",
            description: "x",
            parameters: { type: "object", properties: {} },
          },
          executor: async () => ({}),
        },
      ),
    ).toThrow(AppError);
    try {
      buildSpecialistSessionTools(
        { piTools: [], executors: {} },
        {
          piTool: {
            name: "wrong_tool",
            description: "x",
            parameters: { type: "object", properties: {} },
          },
          executor: async () => ({}),
        },
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "review.submit_tool_mismatch",
        context: { expected: SUBMIT_FINDINGS_REPORT_NAME, got: "wrong_tool" },
      });
    }
  });
});
