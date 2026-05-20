import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubWebhookSignature } from "../src/webhook/verifySignature.js";

describe("verifyGithubWebhookSignature", () => {
  const secret = "mysecret";
  const body = Buffer.from('{"installation":{"id":1}}');

  it("rejects missing or invalid header", () => {
    expect(verifyGithubWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubWebhookSignature(secret, body, "sha1=abc")).toBe(false);
  });

  it("accepts correct sha256 HMAC", () => {
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGithubWebhookSignature(secret, body, `sha256=${expected}`)).toBe(true);
  });

  it("rejects wrong signature", () => {
    const wrong = "a".repeat(64);
    expect(verifyGithubWebhookSignature(secret, body, `sha256=${wrong}`)).toBe(false);
  });
});
