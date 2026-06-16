import { bench, describe } from "vitest";
import { fixDoubleEscapedString } from "../src/agent/tools/fixDoubleEscapedString.js";
import { sanitizeLogMessage } from "../src/security/sanitizeLogMessage.js";

const doubleEscaped = `"line one\\nline two\\ttabbed\\nquote: \\"value\\"\\npath: C:\\\\Users\\\\dev"`;
const escapedBody = Array.from(
  { length: 64 },
  (_, i) => `Step ${i}:\\n\\tcheck condition \\"${i}\\" and continue\\\\`,
).join("\\n");

const noisyLog = [
  "Starting agent run for pull request #1234",
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
  "-----END RSA PRIVATE KEY-----",
  "token=ghs_abcdefghijklmnopqrstuvwxyz0123456789",
].join("\n");

const longLog = `request body: ${"a".repeat(20_000)} token=ghp_${"b".repeat(36)}`;

describe("text processing", () => {
  bench("fixDoubleEscapedString - json string", () => {
    fixDoubleEscapedString(doubleEscaped);
  });

  bench("fixDoubleEscapedString - large escaped body", () => {
    fixDoubleEscapedString(escapedBody);
  });

  bench("sanitizeLogMessage - secrets", () => {
    sanitizeLogMessage(noisyLog);
  });

  bench("sanitizeLogMessage - long input", () => {
    sanitizeLogMessage(longLog);
  });
});
