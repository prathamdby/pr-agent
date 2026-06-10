import { describe, expect, it } from "vitest";
import {
  approximateCursorUsage,
  buildCursorPrompt,
  buildCursorSendText,
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

describe("buildCursorSendText", () => {
  it("uses the full transcript before a reused agent has prior assistant state", () => {
    const { text } = buildCursorSendText(
      {
        systemPrompt: "Review the PR",
        messages: [{ role: "user", content: "Check auth.ts", timestamp: 1 }],
      },
      { reuseAgentConversation: true },
    );

    expect(text).toContain("System:");
    expect(text).toContain("Review the PR");
    expect(text).toContain("Check auth.ts");
  });

  it("uses only the latest user message for reused-agent follow-ups", () => {
    const { text, inputChars } = buildCursorSendText(
      {
        systemPrompt: "Review the PR",
        messages: [
          { role: "user", content: "Check auth.ts", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Initial answer" }],
            api: "cursor-sdk",
            provider: "cursor",
            model: "composer-2.5",
            usage: {
              input: 4,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 8,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
          { role: "user", content: "Repair findings", timestamp: 3 },
        ],
      },
      { reuseAgentConversation: true },
    );

    expect(text).toBe("Repair findings");
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
