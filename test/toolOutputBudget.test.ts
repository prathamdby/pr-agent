import { describe, expect, it } from "vitest";
import { readTextWithOutputBudget } from "../src/agent/tools/toolOutputBudget.js";

describe("readTextWithOutputBudget", () => {
  it("names an empty file instead of returning silent empty content", () => {
    const out = readTextWithOutputBudget("", 1000);
    expect(out).toMatchObject({
      content: "",
      size: 0,
      startLine: 0,
      endLine: 0,
      truncated: false,
      returnedBytes: 0,
      note: "File is empty (0 bytes).",
    });
  });

  it("names an empty file under a line window", () => {
    const out = readTextWithOutputBudget("", 1000, { startLine: 5, maxLines: 10 });
    expect(out.content).toBe("");
    expect(out.note).toBe("File is empty (0 bytes).");
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

  it("keeps windowed reads without dead ends unchanged", () => {
    const out = readTextWithOutputBudget("a\nb\nc\nd\ne\n", 1000, { startLine: 2, maxLines: 2 });
    expect(out).toMatchObject({
      content: "b\nc",
      startLine: 2,
      endLine: 3,
      truncated: true,
      truncationReason: "line window limit exceeded",
    });
    expect(out.note).toBeUndefined();
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
});
