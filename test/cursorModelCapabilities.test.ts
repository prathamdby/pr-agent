import { afterEach, describe, expect, it } from "vitest";
import cursorModelsList from "./fixtures/cursorModelsList.json";
import type { ModelListItem } from "@cursor/sdk";
import {
  discoverFastParamModelIds,
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import { toCursorSdkModelSelection } from "../src/agent/providers/cursor/models.js";

describe("cursor model capabilities", () => {
  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
  });

  it("discovers fast param from Cursor.models.list items", () => {
    const fastIds = discoverFastParamModelIds(cursorModelsList as ModelListItem[]);
    expect(fastIds).toEqual(
      new Set([
        "composer-2.5",
        "composer-2",
        "gpt-5.5",
        "gpt-5.4-high",
        "claude-opus-4-7",
        "claude-opus-4-8",
      ]),
    );
  });

  it("ignores models without a fast parameter", () => {
    const fastIds = discoverFastParamModelIds([
      { id: "auto", displayName: "Auto" },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        parameters: [{ id: "reasoning", values: [{ value: "high" }] }],
      },
    ]);
    expect(fastIds).toEqual(new Set());
  });

  it("includes aliases for fast-capable models", () => {
    const fastIds = discoverFastParamModelIds([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        aliases: ["composer-latest"],
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
    ]);
    expect(fastIds).toEqual(new Set(["composer-2.5", "composer-latest"]));
  });

  it("maps aliases to canonical ids in model selection", () => {
    setCursorModelsForTests([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        aliases: ["composer-latest"],
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
    ]);
    expect(toCursorSdkModelSelection("composer-latest-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("exposes initialized fast ids to model selection", () => {
    setCursorModelsForTests([
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        parameters: [{ id: "fast", values: [] }],
      },
      {
        id: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        parameters: [{ id: "fast", values: [] }],
      },
    ]);
    expect(toCursorSdkModelSelection("gpt-5.5")).toEqual({
      id: "gpt-5.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(toCursorSdkModelSelection("claude-opus-4-7-fast")).toEqual({
      id: "claude-opus-4-7",
      params: [{ id: "fast", value: "true" }],
    });
  });
});
