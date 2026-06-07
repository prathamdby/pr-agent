import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelCapabilitiesForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import {
  assertCursorModelFastSelection,
  assertCursorModelId,
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  isCursorProvider,
  listCursorModelIds,
  toCursorSdkModelSelection,
} from "../src/agent/providers/cursor/models.js";

const FAST_CAPABLE_MODELS = ["composer-2.5", "composer-2", "gpt-5.5", "claude-opus-4-7"];

describe("cursor models", () => {
  beforeEach(() => {
    setCursorModelCapabilitiesForTests(FAST_CAPABLE_MODELS);
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

  it("rejects unknown model ids", () => {
    expect(() => assertCursorModelId("not-a-real-model")).toThrow(/not a supported Cursor model/);
    expect(() => getCursorModel("not-a-real-model")).toThrow(/not a supported Cursor model/);
  });
});
