import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { classifyProviderError } from "../src/agent/providers/providerErrors.js";
import { CodeModeHostHalt } from "../src/agent/codemode/hostHalt.js";

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

  it("classifies insufficient credits as quota", () => {
    expect(classifyProviderError(new Error("Insufficient credits for model"))).toBe("quota");
  });

  it("classifies out of credits / balance as quota", () => {
    expect(classifyProviderError(new Error("out of credits: balance is zero"))).toBe("quota");
  });

  it("classifies billing failures", () => {
    expect(classifyProviderError(new Error("payment required"))).toBe("billing");
  });

  it("classifies 402 payment_required as billing", () => {
    expect(classifyProviderError(new Error("402 Payment Required: balance depleted"))).toBe(
      "billing",
    );
  });

  it("classifies timeouts", () => {
    expect(classifyProviderError(new Error("request timed out"))).toBe("timeout");
  });

  it("classifies host-signal abort as cancelled, not timeout", () => {
    expect(
      classifyProviderError(
        new AppError({ code: "agent.session_aborted", message: "Session aborted" }),
      ),
    ).toBe("cancelled");
    expect(
      classifyProviderError(
        new AppError({
          code: "review.specialist_aborted",
          message: "Specialist run aborted by external signal",
        }),
      ),
    ).toBe("cancelled");
    expect(classifyProviderError(new CodeModeHostHalt("CANCELLED", "cancelled"))).toBe("cancelled");
    expect(
      classifyProviderError(new CodeModeHostHalt("TIMEOUT", "Code Mode exceeded 15000ms")),
    ).toBe("timeout");
  });

  it("returns unknown for unclassified errors", () => {
    expect(classifyProviderError(new Error("something else"))).toBe("unknown");
  });
});
