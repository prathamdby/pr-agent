import { describe, expect, it } from "vitest";
import {
  approximateCursorUsage,
  buildCursorPrompt,
} from "../src/agent/providers/cursor/promptBuilder.js";

describe("buildCursorPrompt", () => {
  it("includes system prompt and user message", () => {
    const { text, inputChars } = buildCursorPrompt({
      systemPrompt: "Review the PR",
      messages: [{ role: "user", content: "Check auth.ts", timestamp: 1 }],
    });
    expect(text).toContain("System:");
    expect(text).toContain("Review the PR");
    expect(text).toContain("Check auth.ts");
    expect(inputChars).toBe(text.length);
  });
});

describe("approximateCursorUsage", () => {
  it("estimates tokens from char counts", () => {
    const usage = approximateCursorUsage(400, 200);
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.totalTokens).toBe(150);
  });
});
