import { describe, expect, it } from "vitest";
import {
  assertCursorModelId,
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  isCursorProvider,
  listCursorModelIds,
  toCursorSdkModelSelection,
} from "../src/agent/providers/cursor/models.js";

describe("cursor models", () => {
  it("builds cursor-sdk models for catalog ids", () => {
    expect(isCursorProvider(CURSOR_PROVIDER)).toBe(true);
    expect(listCursorModelIds()).toContain("composer-2.5");
    expect(listCursorModelIds()).toContain("composer-2.5-fast");
    const model = getCursorModel("composer-2.5");
    expect(model.api).toBe(CURSOR_API);
    expect(model.provider).toBe(CURSOR_PROVIDER);
    expect(model.id).toBe("composer-2.5");
  });

  it("maps composer-2.5 to standard tier unless -fast suffix is set", () => {
    expect(toCursorSdkModelSelection("composer-2.5")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(toCursorSdkModelSelection("composer-2.5-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("leaves non-composer models without fast params", () => {
    expect(toCursorSdkModelSelection("auto")).toEqual({ id: "auto" });
    expect(toCursorSdkModelSelection("gpt-5.5")).toEqual({ id: "gpt-5.5" });
  });

  it("accepts -fast suffix in config validation", () => {
    expect(() => assertCursorModelId("composer-2.5-fast")).not.toThrow();
    expect(getCursorModel("composer-2.5-fast").id).toBe("composer-2.5");
  });

  it("rejects unknown model ids", () => {
    expect(() => assertCursorModelId("not-a-real-model")).toThrow(/not a supported Cursor model/);
    expect(() => getCursorModel("not-a-real-model")).toThrow(/not a supported Cursor model/);
    expect(() => assertCursorModelId("auto-fast")).toThrow(/not a supported Cursor model/);
  });
});
