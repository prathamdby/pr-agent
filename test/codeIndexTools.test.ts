import { describe, expect, it } from "vitest";
import { buildUnavailableCodeIndexTools } from "../src/agent/tools/codeIndexTools.js";

describe("codeIndex tools", () => {
  it("returns unavailable when mode is off or snapshot missing", async () => {
    const { executors } = buildUnavailableCodeIndexTools();
    const result = await executors.searchCodeIndex?.({ query: "auth" });
    expect(result).toEqual({ unavailable: true });
  });
});
