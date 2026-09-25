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

  it("preserves cacheWrite1h when the provider reports it", () => {
    expect(
      exactUsageFromProviderUsage({
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 4,
        cacheWrite1h: 2,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({
      estimated: false,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      cacheWrite1hTokens: 2,
      totalTokens: 15,
    });
  });

  it("merges exact usage across turns", () => {
    const left = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      cacheWrite1h: 1,
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
      cacheWrite1hTokens: 1,
      totalTokens: 20,
    });
  });

  it("preserves unknown cache metrics when merging turns without cache data", () => {
    const withTokens = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const withoutCache = {
      estimated: false as const,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    };
    expect(mergeExactUsage(withTokens, withoutCache)).toEqual({
      estimated: false,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 20,
    });
    expect(mergeExactUsage(withoutCache, withoutCache)).toEqual({
      estimated: false,
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
    });
  });

  it("omits cache keys the provider did not report", () => {
    const usage = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as unknown as Parameters<typeof exactUsageFromProviderUsage>[0]);
    expect(usage).toStrictEqual({
      estimated: false,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(usage).not.toHaveProperty("cacheReadTokens");
    expect(usage).not.toHaveProperty("cacheWriteTokens");
    expect(usage).not.toHaveProperty("cacheWrite1hTokens");
  });

  it("keeps explicit zero cache counts", () => {
    const usage = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(usage).toStrictEqual({
      estimated: false,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
    });
  });

  it("keeps merged cache keys absent when neither turn reports them", () => {
    const left = {
      estimated: false as const,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
    const right = {
      estimated: false as const,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    };
    const merged = mergeExactUsage(left, right);
    expect(merged).not.toHaveProperty("cacheReadTokens");
    expect(merged).not.toHaveProperty("cacheWriteTokens");
    expect(merged).not.toHaveProperty("cacheWrite1hTokens");
    expect(merged).toStrictEqual({
      estimated: false,
      inputTokens: 13,
      outputTokens: 7,
      totalTokens: 20,
    });
  });

  it("keeps known cache counts when merging with a turn that omits them", () => {
    const known = exactUsageFromProviderUsage({
      input: 10,
      output: 5,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const unknownCache = {
      estimated: false as const,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    };
    expect(mergeExactUsage(known, unknownCache)).toStrictEqual({
      estimated: false,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      totalTokens: 20,
    });
    expect(mergeExactUsage(unknownCache, known)).toStrictEqual({
      estimated: false,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      totalTokens: 20,
    });
  });
});
