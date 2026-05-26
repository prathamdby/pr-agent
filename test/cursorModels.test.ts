import { describe, expect, it } from "vitest";
import {
  assertCursorModelId,
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  isCursorProvider,
  listCursorModelIds,
} from "../src/agent/providers/cursor/models.js";

describe("cursor models", () => {
  it("builds cursor-sdk models for catalog ids", () => {
    expect(isCursorProvider(CURSOR_PROVIDER)).toBe(true);
    expect(listCursorModelIds()).toContain("composer-2.5");
    const model = getCursorModel("composer-2.5");
    expect(model.api).toBe(CURSOR_API);
    expect(model.provider).toBe(CURSOR_PROVIDER);
  });

  it("rejects unknown model ids", () => {
    expect(() => assertCursorModelId("not-a-real-model")).toThrow(/not a supported Cursor model/);
    expect(() => getCursorModel("not-a-real-model")).toThrow(/Unknown Cursor model/);
  });
});
