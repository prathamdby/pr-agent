import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cursorModelsList from "./fixtures/cursorModelsList.json" with { type: "json" };
import type { ModelListItem } from "@cursor/sdk";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import {
  assertCursorModelFastSelection,
  assertCursorModelId,
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  isCursorProvider,
  listCursorModelIds,
  listTopCursorModelIds,
  toCursorSdkModelSelection,
} from "../src/agent/providers/cursor/models.js";

const catalog = cursorModelsList as ModelListItem[];

describe("cursor models", () => {
  beforeEach(() => {
    setCursorModelsForTests(catalog);
  });

  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
  });

  it("builds cursor-sdk models for catalog ids", () => {
    expect(isCursorProvider(CURSOR_PROVIDER)).toBe(true);
    expect(listCursorModelIds()).toContain("composer-2.5");
    expect(listCursorModelIds()).toContain("gpt-5.5-fast");
    const model = getCursorModel("composer-2.5");
    expect(model.api).toBe(CURSOR_API);
    expect(model.provider).toBe(CURSOR_PROVIDER);
    expect(model.id).toBe("composer-2.5");
    expect(model.name).toBe("Composer 2.5");
  });

  it("lists the first ten catalog ids", () => {
    expect(listTopCursorModelIds()).toEqual([
      "composer-2.5",
      "composer-2",
      "gpt-5.5",
      "gpt-5.4-high",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-4.6-sonnet-high-thinking",
      "gpt-5.3-codex-high",
      "gemini-3.1-pro",
      "auto",
    ]);
  });

  it("maps fast-capable models to explicit fast params", () => {
    expect(toCursorSdkModelSelection("composer-2.5")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(toCursorSdkModelSelection("gpt-5.5-fast")).toEqual({
      id: "gpt-5.5",
      params: [{ id: "fast", value: "true" }],
    });
    expect(toCursorSdkModelSelection("claude-opus-4-7")).toEqual({
      id: "claude-opus-4-7",
      params: [{ id: "fast", value: "false" }],
    });
  });

  it("leaves models without fast parameter unset", () => {
    expect(toCursorSdkModelSelection("auto")).toEqual({ id: "auto" });
  });

  it("accepts -fast suffix in catalog validation", () => {
    expect(() => assertCursorModelId("composer-2.5-fast")).not.toThrow();
    expect(getCursorModel("composer-2.5-fast").id).toBe("composer-2.5");
  });

  it("rejects unsupported fast suffix after capabilities load", () => {
    expect(() => assertCursorModelFastSelection("auto-fast")).toThrow(/does not support fast mode/);
  });

  it("validates fast selection against canonical catalog ids", () => {
    setCursorModelsForTests([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        aliases: ["composer-latest"],
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
    ]);
    expect(() => assertCursorModelFastSelection("composer-latest-fast")).not.toThrow();
    expect(toCursorSdkModelSelection("composer-latest-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("rejects unknown model ids", () => {
    expect(() => assertCursorModelId("not-a-real-model")).toThrow(/not a supported Cursor model/);
    expect(() => getCursorModel("not-a-real-model")).toThrow(/not a supported Cursor model/);
  });
});
