import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGithubAppPrivateKey } from "../src/config.js";

function testPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return privateKey.export({ type: "pkcs1", format: "pem" });
}

describe("normalizeGithubAppPrivateKey", () => {
  it("accepts escaped newlines wrapped in quotes", () => {
    const pem = testPrivateKeyPem();
    const escaped = `"${pem.trimEnd().replace(/\n/g, "\\n")}"`;

    const normalized = normalizeGithubAppPrivateKey(escaped);

    expect(normalized).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(normalized).toContain("\n");
    expect(normalized).not.toContain('"');
  });

  it("accepts base64-encoded PEM", () => {
    const pem = testPrivateKeyPem();
    const encoded = Buffer.from(pem).toString("base64");

    const normalized = normalizeGithubAppPrivateKey(encoded);

    expect(normalized).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(normalized).toContain("\n");
  });

  it("throws a clear error for invalid key content", () => {
    expect(() => normalizeGithubAppPrivateKey("not-a-private-key")).toThrow(
      /GITHUB_APP_PRIVATE_KEY must be a valid unencrypted PEM private key/,
    );
  });
});
