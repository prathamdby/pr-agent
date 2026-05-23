import { describe, expect, it } from "vitest";
import {
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  isCursorProvider,
  listCursorModelIds,
} from "../src/agent/cursor/models.js";

describe("cursor models", () => {
  it("builds cursor-sdk models for catalog ids", () => {
    expect(isCursorProvider(CURSOR_PROVIDER)).toBe(true);
    expect(listCursorModelIds()).toContain("composer-2.5");
    const model = getCursorModel("composer-2.5");
    expect(model.api).toBe(CURSOR_API);
    expect(model.provider).toBe(CURSOR_PROVIDER);
  });

  it("falls back to composer-2.5 for unknown ids", () => {
    const model = getCursorModel("not-a-real-model");
    expect(model.id).toBe("composer-2.5");
  });
});
