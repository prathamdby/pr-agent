import { describe, expect, it } from "vitest";
import { normalizeGithubAppPrivateKey } from "../src/config.js";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

describe("normalizeGithubAppPrivateKey", () => {
  it("accepts escaped newlines wrapped in quotes", () => {
    const pem = TEST_PRIVATE_KEY_PEM;
    const escaped = `"${pem.trimEnd().replace(/\n/g, "\\n")}"`;

    const normalized = normalizeGithubAppPrivateKey(escaped);

    expect(normalized).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(normalized).toContain("\n");
    expect(normalized).not.toContain('"');
  });

  it("accepts base64-encoded PEM", () => {
    const pem = TEST_PRIVATE_KEY_PEM;
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
