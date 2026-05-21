import { describe, expect, it } from "vitest";
import {
  containsBannedPublicOutput,
  sanitizePublicReviewText,
} from "../src/agent/publicOutputSanitizer.js";

describe("publicOutputSanitizer", () => {
  it("redacts internal publish failure phrases", () => {
    expect(
      sanitizePublicReviewText("Structured publish failed after 3/3 attempt(s). Check server logs."),
    ).toBe("[redacted internal details]");
  });

  it("leaves normal finding text unchanged", () => {
    const text = "Missing await on promise before returning from handler.";
    expect(sanitizePublicReviewText(text)).toBe(text);
    expect(containsBannedPublicOutput(text)).toBe(false);
  });
});
