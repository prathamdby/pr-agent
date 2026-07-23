import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { classifyFallbackEligibility } from "../src/agent/runtime/fallbackClassification.js";

describe("classifyFallbackEligibility", () => {
  const eligible: Array<[string, unknown]> = [
    ["transport", new Error("fetch failed: ECONNRESET")],
    ["rate_limit", new Error("429 Too Many Requests: rate limit exceeded")],
    ["provider_5xx", new Error("502 Bad Gateway")],
    [
      "model_unavailable",
      new AppError({ code: "provider.model_not_found", message: "Model not found: x/y" }),
    ],
  ];

  const ineligible: Array<[string, unknown]> = [
    ["auth", new Error("401 Unauthorized invalid api key")],
    [
      "config",
      new AppError({ code: "config.missing_env", message: "Missing required environment variable" }),
    ],
    ["invalid_request", new Error("invalid_request: malformed json body")],
    ["context_limit", new Error("maximum context length exceeded")],
    [
      "tool",
      new AppError({ code: "provider.missing_tool_executor", message: "No executor registered" }),
    ],
    ["validation", new Error("schema validation failed for payload")],
    [
      "internal",
      new AppError({ code: "internal.invariant", message: "Internal invariant violated" }),
    ],
    ["cancellation", new Error("session cancelled by supersede")],
    [
      "deadline",
      new AppError({ code: "pi.prompt_idle_timeout", message: "Provider prompt timeout" }),
    ],
  ];

  it.each(eligible)("marks %s as eligible", (reason, error) => {
    const result = classifyFallbackEligibility(error);
    expect(result.eligible).toBe(true);
    if (result.eligible) expect(result.reason).toBe(reason);
  });

  it.each(ineligible)("marks %s as ineligible", (reason, error) => {
    const result = classifyFallbackEligibility(error);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toBe(reason);
  });
});
