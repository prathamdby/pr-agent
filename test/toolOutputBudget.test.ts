import { describe, expect, it } from "vitest";
import { readTextWithOutputBudget } from "../src/agent/tools/toolOutputBudget.js";
import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../src/settings/index.js";

const OVER_LIMIT = LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS + 1;

describe("readTextWithOutputBudget", () => {
  it("returns a zero-line shape for an empty file", () => {
    const out = readTextWithOutputBudget("", 1000);
    expect(out).toMatchObject({
      content: "",
      size: 0,
      startLine: 0,
      endLine: 0,
      truncated: false,
      returnedBytes: 0,
    });
    expect(out.note).toBeUndefined();
  });

  it("returns the same zero-line shape for an empty file under a line window", () => {
    const out = readTextWithOutputBudget("", 1000, { startLine: 5, maxLines: 10 });
    expect(out).toMatchObject({ content: "", startLine: 0, endLine: 0, truncated: false });
    expect(out.note).toBeUndefined();
  });

  it("names a startLine beyond end of file with the real line count and retry bound", () => {
    const out = readTextWithOutputBudget("a\nb\nc\n", 1000, { startLine: 900, maxLines: 50 });
    expect(out).toMatchObject({
      content: "",
      startLine: 0,
      endLine: 0,
      truncated: false,
      note: "startLine 900 is beyond the end of the file (3 lines total). Retry with startLine <= 3.",
    });
  });

  it("still reads when startLine equals the last line", () => {
    const out = readTextWithOutputBudget("a\nb\nc\n", 1000, { startLine: 3, maxLines: 10 });
    expect(out.content).toBe("c");
    expect(out.startLine).toBe(3);
    expect(out.endLine).toBe(3);
    expect(out.note).toBeUndefined();
  });

  it("names the next start line when a line window truncates", () => {
    const out = readTextWithOutputBudget("a\nb\nc\nd\ne\n", 1000, { startLine: 2, maxLines: 2 });
    expect(out).toMatchObject({
      content: "b\nc",
      startLine: 2,
      endLine: 3,
      truncated: true,
      truncationReason: "line window limit exceeded",
      resumeStartLine: 4,
      note: "Line window ended at line 3 of 5. Resume with startLine 4.",
    });
  });

  it("keeps uncapped full reads unchanged", () => {
    const out = readTextWithOutputBudget("hello\n", 1000);
    expect(out).toMatchObject({
      content: "hello\n",
      size: 6,
      startLine: 1,
      endLine: 1,
      truncated: false,
    });
    expect(out.note).toBeUndefined();
  });

  it("resumes on the last shown line when the byte budget cuts mid-line", () => {
    const text = "aaaa\nbbbb\ndddd\n";
    const out = readTextWithOutputBudget(text, 6); // fits "aaaa\n" plus a byte of "bbbb"
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("response byte budget exceeded");
    expect(out.endLine).toBe(2);
    expect(out.resumeStartLine).toBe(2);
    expect(out.note).toBe(
      "Truncated by the response byte budget at line 2 of 3. Resume with startLine 2 (the last shown line may be cut off).",
    );
  });

  it("resumes on the partially shown line when the byte budget fires inside a window", () => {
    const text = "aaaa\nbbbb\ndddd\neeee\n";
    const out = readTextWithOutputBudget(text, 7, { startLine: 2, maxLines: 3 });
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.resumeStartLine).toBe(3);
    expect(out.note).toContain("Resume with startLine 3");
  });

  it("replaces an over-long line with a marker naming its line number and length", () => {
    const text = `short\n${"x".repeat(OVER_LIMIT)}\ntail\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(`short\n[line 2 clamped: ${OVER_LIMIT} characters elided]\ntail\n`);
    expect(out.endLine).toBe(3);
  });

  it("keeps marker line numbers absolute under a line window", () => {
    const text = `a\nb\nc\n${"y".repeat(OVER_LIMIT)}\ne\n`;
    const out = readTextWithOutputBudget(text, 128_000, { startLine: 4, maxLines: 1 });
    expect(out.content).toBe(`[line 4 clamped: ${OVER_LIMIT} characters elided]`);
    expect(out.startLine).toBe(4);
    expect(out.endLine).toBe(4);
    expect(out.truncated).toBe(true);
    expect(out.resumeStartLine).toBe(5);
  });

  it("clamps a mega-line before the byte budget so surrounding lines survive", () => {
    const text = `${"m".repeat(500_000)}\nafter\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(`[line 1 clamped: 500000 characters elided]\nafter\n`);
  });
});
