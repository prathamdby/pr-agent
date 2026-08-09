import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  SEARCH_CODE_INDEX_DESCRIPTION,
  buildCodeIndexTools,
  buildUnavailableCodeIndexTools,
  searchCodeIndexSchema,
} from "../src/agent/tools/codeIndexTools.js";
import { toPiTool } from "../src/agent/tools/defineWorkspaceTool.js";

describe("codeIndex tools", () => {
  it("returns unavailable when mode is off or snapshot missing", async () => {
    const { executors } = buildUnavailableCodeIndexTools();
    const result = await executors.searchCodeIndex?.({ query: "auth" });
    expect(result).toEqual({ unavailable: true });
  });

  it("keeps one description and schema for available and unavailable variants", () => {
    const unavailable = buildUnavailableCodeIndexTools().piTools[0];
    expect(unavailable?.name).toBe("searchCodeIndex");
    expect(unavailable?.description).toBe(SEARCH_CODE_INDEX_DESCRIPTION);

    const availableDefinition = toPiTool("searchCodeIndex", {
      description: SEARCH_CODE_INDEX_DESCRIPTION,
      schema: searchCodeIndexSchema,
      run: async () => ({ hints: [] }),
    });
    expect(JSON.stringify(unavailable?.parameters)).toBe(
      JSON.stringify(availableDefinition.parameters),
    );
    expect(unavailable?.description).toBe(availableDefinition.description);

    // buildCodeIndexTools shares the same exported description/schema constants.
    expect(typeof buildCodeIndexTools).toBe("function");
    expect(v.safeParse(searchCodeIndexSchema, { query: "x" }).success).toBe(true);
  });
});
