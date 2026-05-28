import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/agent/providerErrors.js";

describe("classifyProviderError", () => {
  it("classifies auth failures", () => {
    expect(classifyProviderError(new Error("401 Unauthorized"))).toBe("auth");
  });

  it("classifies rate limits", () => {
    expect(classifyProviderError(new Error("429 rate limit exceeded"))).toBe("rate_limit");
  });

  it("returns unknown for unclassified errors", () => {
    expect(classifyProviderError(new Error("something else"))).toBe("unknown");
  });
});
