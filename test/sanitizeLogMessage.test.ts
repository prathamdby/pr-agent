import { describe, expect, it } from "vitest";
import { sanitizeLogMessage } from "../src/security/sanitizeLogMessage.js";

describe("sanitizeLogMessage", () => {
  it("strips null bytes", () => {
    expect(sanitizeLogMessage("fail\0here")).toBe("failhere");
  });

  it("redacts bearer tokens", () => {
    expect(sanitizeLogMessage("auth failed Bearer ghp_abc123")).toBe("auth failed [redacted]");
  });

  it("redacts labeled secrets", () => {
    expect(sanitizeLogMessage("token=supersecret password: x api_key=123")).toBe(
      "[redacted] [redacted] [redacted]",
    );
  });

  it("redacts installation tokens in stderr", () => {
    const out = sanitizeLogMessage("clone failed for ghs_0123456789012345678901234567890123");
    expect(out).not.toContain("ghs_0123456789012345678901234567890123");
    expect(out).toContain("[redacted]");
  });

  it("redacts Authorization headers", () => {
    expect(sanitizeLogMessage("Authorization: Bearer xyz")).toBe("[redacted]");
    expect(sanitizeLogMessage("Authorization: Token abc123")).toBe("[redacted]");
    expect(sanitizeLogMessage("Authorization: Basic dXNlcjpwYXNz")).toBe("[redacted]");
  });

  it("truncates to 2000 characters", () => {
    const long = "x".repeat(2500);
    expect(sanitizeLogMessage(long)).toHaveLength(2000);
  });
});
