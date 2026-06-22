import { describe, expect, it } from "vitest";
import {
  estimatedUsageFromTokenCounts,
  exactUsageFromProviderUsage,
  mergeExactUsage,
  promptMetadataFromText,
} from "../src/agent/providers/usageMetadata.js";

describe("usageMetadata", () => {
  it("builds prompt metadata from text without logging content", () => {
    const meta = promptMetadataFromText("hello 🌍");
    expect(meta.inputCharacters).toBe(8);
    expect(meta.inputBytes).toBeGreaterThan(meta.inputCharacters);
  });

  it("marks estimated usage explicitly", () => {
    expect(estimatedUsageFromTokenCounts(10, 5)).toEqual({
      estimated: true,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("returns exact provider usage only when token data exists", () => {
    expect(
      exactUsageFromProviderUsage({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBeUndefined();
    expect(
      exactUsageFromProviderUsage({
        input: 12,
        output: 4,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({
      estimated: false,
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalTokens: 16,
    });
  });

  it("merges exact usage across turns", () => {
    const left = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const right = exactUsageFromProviderUsage({
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 2,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(mergeExactUsage(left, right)).toEqual({
      estimated: false,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      totalTokens: 20,
    });
  });
});
