import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/agent/providers/providerErrors.js";

describe("classifyProviderError", () => {
  it("classifies auth failures", () => {
    expect(classifyProviderError(new Error("401 Unauthorized"))).toBe("auth");
  });

  it("classifies rate limits", () => {
    expect(classifyProviderError(new Error("429 rate limit exceeded"))).toBe("rate_limit");
  });

  it("classifies quota failures", () => {
    expect(classifyProviderError(new Error("quota exceeded"))).toBe("quota");
  });

  it("classifies billing failures", () => {
    expect(classifyProviderError(new Error("payment required"))).toBe("billing");
  });

  it("classifies timeouts", () => {
    expect(classifyProviderError(new Error("request timed out"))).toBe("timeout");
  });

  it("returns unknown for unclassified errors", () => {
    expect(classifyProviderError(new Error("something else"))).toBe("unknown");
  });
});
