import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cursorModelsList from "./fixtures/cursorModelsList.json" with { type: "json" };
import type { ModelListItem } from "@cursor/sdk";
import {
  resetCursorModelCatalog,
  seedCursorModelCatalog,
} from "./helpers/cursorModelCatalogMock.js";
import {
  assertCursorModelFastSelection,
  assertCursorModelId,
  CURSOR_API,
  CURSOR_PROVIDER,
  getCursorModel,
  listCursorModelIds,
  listTopCursorModelIds,
  toCursorSdkModelSelection,
} from "../src/agent/providers/cursor/models.js";

const catalog = cursorModelsList as ModelListItem[];

describe("cursor models", () => {
  beforeEach(() => {
    seedCursorModelCatalog(catalog);
  });

  afterEach(() => {
    resetCursorModelCatalog();
  });

  it("exposes cursor provider constants", () => {
    expect(CURSOR_PROVIDER).toBe("cursor");
    expect(CURSOR_API).toBe("cursor-sdk");
  });

  it("lists model ids from catalog", () => {
    expect(listCursorModelIds()).toContain("composer-2.5");
  });

  it("lists top model ids", () => {
    expect(listTopCursorModelIds()).toHaveLength(10);
  });

  it("resolves model by id", () => {
    const model = getCursorModel("composer-2.5");
    expect(model.id).toBe("composer-2.5");
    expect(model.api).toBe(CURSOR_API);
  });

  it("maps fast suffix to fast param", () => {
    expect(toCursorSdkModelSelection("composer-2.5-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("asserts model id exists", () => {
    expect(() => assertCursorModelId("composer-2.5")).not.toThrow();
    expect(() => assertCursorModelId("missing-model")).toThrow(/not a supported Cursor model/);
  });

  it("asserts fast selection for fast-capable models", () => {
    expect(() => assertCursorModelFastSelection("composer-2.5-fast")).not.toThrow();
    expect(() => assertCursorModelFastSelection("auto-fast")).toThrow(/does not support fast/);
  });
});
