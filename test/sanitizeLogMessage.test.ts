import { describe, expect, it } from "vitest";
import { MAX_LOG_MESSAGE_LEN, MAX_LOG_REDACTION_SCAN_LEN } from "../src/settings.js";
import { sanitizeLogMessage } from "../src/security.js";

const jwtLikeSecret = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(5)}`;

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

  it.each([
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    jwtLikeSecret,
    "sk_live_1234567890abcdef",
  ])("redacts boundary secret %s", (secret) => {
    const out = sanitizeLogMessage(`leak ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it.each(["skylight", "eyJsomething", "secret key rotation"])(
    "preserves non-secret text %s",
    (text) => {
      expect(sanitizeLogMessage(text)).toBe(text);
    },
  );

  it("redacts Authorization headers", () => {
    expect(sanitizeLogMessage("Authorization: Bearer xyz")).toBe("[redacted]");
    expect(sanitizeLogMessage("Authorization: Token abc123")).toBe("[redacted]");
    expect(sanitizeLogMessage("Authorization: Basic dXNlcjpwYXNz")).toBe("[redacted]");
  });

  it("truncates to 2000 characters", () => {
    const long = "x".repeat(2500);
    expect(sanitizeLogMessage(long)).toHaveLength(MAX_LOG_MESSAGE_LEN);
  });

  it("redacts tokens before final truncation", () => {
    const secret = "ghs_0123456789012345678901234567890123";
    const out = sanitizeLogMessage(
      `clone failed ${secret} ${"x".repeat(MAX_LOG_REDACTION_SCAN_LEN)}`,
    );
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    expect(out).toHaveLength(MAX_LOG_MESSAGE_LEN);
  });

  it("redacts private key starts that run past the scan cap", () => {
    const out = sanitizeLogMessage(
      `failed -----BEGIN RSA PRIVATE KEY-----\n${"x".repeat(MAX_LOG_REDACTION_SCAN_LEN * 2)}`,
    );
    expect(out).toBe("failed [redacted]");
  });
});
