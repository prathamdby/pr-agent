import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import * as evlog from "../src/evlog.js";
import { defineLocalTool, toExecutor } from "../src/agent/tools/defineWorkspaceTool.js";
import { parseToolInput } from "../src/agent/tools/parseToolInput.js";

const schema = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  tags: v.optional(v.array(v.string())),
  items: v.optional(v.array(v.object({ name: v.string() }))),
  count: v.optional(v.number()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
  nested: v.optional(v.object({ flags: v.optional(v.array(v.string())) })),
});

describe("parseToolInput", () => {
  it("passes valid input through untouched", () => {
    const logDebug = vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    const input = { path: "src/a.ts", tags: ["a"], count: 2 };
    const result = parseToolInput(schema, input, { toolName: "readWorkspaceFile" });
    expect(result).toEqual({ ok: true, value: input, repairs: [] });
    expect(logDebug).not.toHaveBeenCalled();
    logDebug.mockRestore();
  });

  it("drops null values where the schema field is optional", () => {
    const result = parseToolInput(schema, { path: "a", count: null }, { toolName: "t" });
    expect(result).toMatchObject({ ok: true, value: { path: "a" } });
    expect(result.ok && result.repairs).toEqual(["null_optional_dropped"]);
  });

  it("drops null on an optional field wrapped in a pipe", () => {
    // Every production optional routed through the seam is optional(pipe(...))
    // — codeIndex limit, workspace startLine/maxLines, reviewSchema confidence.
    const result = parseToolInput(schema, { path: "a", limit: null }, { toolName: "t" });
    expect(result).toMatchObject({ ok: true, value: { path: "a" } });
    expect(result.ok && result.repairs).toEqual(["null_optional_dropped"]);
  });

  it("refuses to drop null for a required field", () => {
    const result = parseToolInput(schema, { path: null }, { toolName: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("path");
    }
  });

  it("never splices a null array item", () => {
    const result = parseToolInput(schema, { path: "a", tags: [null] }, { toolName: "t" });
    expect(result.ok).toBe(false);
  });

  it("parses a stringified JSON array instead of double-wrapping it", () => {
    const result = parseToolInput(schema, { path: "a", tags: '["x","y"]' }, { toolName: "t" });
    expect(result).toMatchObject({ ok: true, value: { path: "a", tags: ["x", "y"] } });
    expect(result.ok && result.repairs).toEqual(["stringified_json_array"]);
  });

  it("leaves a stringified object unrepairable when an object array is expected", () => {
    const result = parseToolInput(schema, { path: "a", items: '{"name":"x"}' }, { toolName: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("items");
    }
  });

  it("wraps a single object where an array is expected", () => {
    const result = parseToolInput(schema, { path: "a", items: { name: "x" } }, { toolName: "t" });
    expect(result).toMatchObject({ ok: true, value: { path: "a", items: [{ name: "x" }] } });
    expect(result.ok && result.repairs).toEqual(["object_wrapped_as_array"]);
  });

  it("wraps a bare string where an array of strings is expected", () => {
    const result = parseToolInput(schema, { path: "a", tags: "bug" }, { toolName: "t" });
    expect(result).toMatchObject({ ok: true, value: { path: "a", tags: ["bug"] } });
    expect(result.ok && result.repairs).toEqual(["string_wrapped_as_array"]);
  });

  it("repairs at nested dot paths", () => {
    const result = parseToolInput(
      schema,
      { path: "a", nested: { flags: '["x"]' } },
      { toolName: "t" },
    );
    expect(result).toMatchObject({ ok: true, value: { path: "a", nested: { flags: ["x"] } } });
  });

  it("repairs inside array elements", () => {
    const arraySchema = v.object({
      findings: v.array(v.object({ name: v.string(), tags: v.optional(v.array(v.string())) })),
    });
    const result = parseToolInput(
      arraySchema,
      { findings: [{ name: "a", tags: "solo" }] },
      { toolName: "t" },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { findings: [{ name: "a", tags: ["solo"] }] },
    });
  });

  it("returns the re-parse issue list when a repair is not enough", () => {
    const logDebug = vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    const result = parseToolInput(schema, { path: "a", tags: '["x",5]' }, { toolName: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tags.1");
    }
    // The applied repair is still logged even though the payload stayed invalid.
    expect(logDebug).toHaveBeenCalledWith("tool_input_repaired", {
      tool: "t",
      repairs: ["stringified_json_array"],
    });
    logDebug.mockRestore();
  });

  it("returns the first issue list when no repair applies", () => {
    const result = parseToolInput(schema, { path: "" }, { toolName: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Tool input validation failed:");
      expect(result.error).toContain("path");
    }
  });

  it("logs every applied repair with tool name and repair kinds", () => {
    const logDebug = vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    parseToolInput(schema, { path: "a", count: null, tags: "bug" }, { toolName: "editTool" });
    expect(logDebug).toHaveBeenCalledWith("tool_input_repaired", {
      tool: "editTool",
      repairs: expect.arrayContaining(["null_optional_dropped", "string_wrapped_as_array"]),
    });
    logDebug.mockRestore();
  });

  it("does not mutate the caller's arguments while repairing", () => {
    const input = { path: "a", count: null };
    parseToolInput(schema, input, { toolName: "t" });
    expect(input).toEqual({ path: "a", count: null });
  });
});

describe("toExecutor tool-input repair", () => {
  function echoTool() {
    const run = vi.fn(async (parsed: unknown) => parsed);
    const tool = defineLocalTool({ description: "echo", schema, run });
    return { run, executor: toExecutor("echo", tool) };
  }

  it("delivers repaired values to the tool run function", async () => {
    const { run, executor } = echoTool();
    await executor({ path: "a", tags: '["x"]' });
    expect(run).toHaveBeenCalledWith({ path: "a", tags: ["x"] });
  });

  it("delivers valid arguments unmutated", async () => {
    const { run, executor } = echoTool();
    await executor({ path: "a", tags: ["x"] });
    expect(run).toHaveBeenCalledWith({ path: "a", tags: ["x"] });
  });

  it("never calls run for unrepairable input and names the failing paths", async () => {
    const { run, executor } = echoTool();
    await expect(executor({ path: 42 })).rejects.toThrow(/echo validation failed:[\s\S]*- path:/);
    expect(run).not.toHaveBeenCalled();
  });
});
