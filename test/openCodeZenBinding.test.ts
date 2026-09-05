import { describe, expect, it } from "vitest";
import {
  bindOpenCodeZenModel,
  isOpenCodeZenMuseSparkModel,
  isOpenCodeZenProvider,
  mapOpenCodeZenThinkingLevel,
  MUSE_SPARK_THINKING_LEVEL_MAP,
} from "../src/settings/openCodeZenBinding.js";

describe("openCodeZenBinding", () => {
  it("leaves unrelated providers unchanged", () => {
    const model = {
      id: "gpt-4o-mini",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
    };
    expect(bindOpenCodeZenModel(model)).toBe(model);
  });

  it("binds opencode-zen muse-spark onto the native Responses tool path", () => {
    expect(
      bindOpenCodeZenModel({
        id: "muse-spark-1.3-contributor-free",
        provider: "opencode-zen",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/v1/chat/completions",
        reasoning: false,
      }),
    ).toEqual({
      id: "muse-spark-1.3-contributor-free",
      provider: "opencode",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      thinkingLevelMap: MUSE_SPARK_THINKING_LEVEL_MAP,
    });
  });

  it("keeps a non-muse OpenCode completions model on completions after alias remap", () => {
    expect(
      bindOpenCodeZenModel({
        id: "kimi-k2.6",
        provider: "opencode-zen",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/v1",
        reasoning: true,
      }),
    ).toEqual({
      id: "kimi-k2.6",
      provider: "opencode",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
    });
  });

  it("maps muse-spark thinking off and none to minimal", () => {
    expect(isOpenCodeZenProvider("opencode-zen")).toBe(true);
    expect(isOpenCodeZenMuseSparkModel("muse-spark-1.3-contributor-free")).toBe(true);
    expect(mapOpenCodeZenThinkingLevel("off")).toBe("minimal");
    expect(mapOpenCodeZenThinkingLevel("none")).toBe("minimal");
    expect(mapOpenCodeZenThinkingLevel("max")).toBe("xhigh");
    expect(mapOpenCodeZenThinkingLevel("medium")).toBe("medium");
  });
});
