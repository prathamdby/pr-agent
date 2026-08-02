import { describe, expect, it } from "vitest";
import { newRequestId, redact } from "./log";

describe("site log helpers", () => {
  it("redacts secret-shaped substrings", () => {
    expect(redact("api_key=supersecret token=abc")).toMatch(/\[REDACTED\]/);
  });

  it("prefers incoming request id", () => {
    expect(newRequestId("  abc-123  ")).toBe("abc-123");
  });

  it("generates an id when missing", () => {
    expect(newRequestId(null).length).toBeGreaterThan(8);
  });
});
