import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../src/settings/index.js";
import {
  readTextWithOutputBudget,
  shouldSpillToFile,
} from "../src/agent/tools/toolOutputBudget.js";
import {
  readBudgetedWorkspaceTextFile,
  spillTextToSessionFile,
} from "../src/agent/tools/readWorkspaceTextFile.js";

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
    expect(out.clampedLines).toEqual([2]);
  });

  it("reports no clamped lines when nothing was elided", () => {
    const out = readTextWithOutputBudget("a\nb\n", 128_000);
    expect(out.clampedLines).toBeUndefined();
  });

  it("keeps marker line numbers absolute under a line window", () => {
    const text = `a\nb\nc\n${"y".repeat(OVER_LIMIT)}\ne\n`;
    const out = readTextWithOutputBudget(text, 128_000, { startLine: 4, maxLines: 1 });
    expect(out.content).toBe(`[line 4 clamped: ${OVER_LIMIT} characters elided]`);
    expect(out.startLine).toBe(4);
    expect(out.endLine).toBe(4);
    expect(out.truncated).toBe(true);
    expect(out.resumeStartLine).toBe(5);
    expect(out.clampedLines).toEqual([4]);
  });

  it("clamps a mega-line before the byte budget so surrounding lines survive", () => {
    const text = `${"m".repeat(500_000)}\nafter\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(`[line 1 clamped: 500000 characters elided]\nafter\n`);
  });
});

describe("shouldSpillToFile", () => {
  it.each([
    { bytes: 100, threshold: 100, expected: false, name: "equal stays inline" },
    { bytes: 101, threshold: 100, expected: true, name: "one over spills" },
    { bytes: 0, threshold: 0, expected: false, name: "zero threshold never spills on empty" },
    { bytes: 1, threshold: 0, expected: true, name: "any byte spills past a zero threshold" },
    { bytes: 100, threshold: 99, expected: true, name: "over spills" },
    { bytes: 99, threshold: 100, expected: false, name: "under stays inline" },
  ])("$name", ({ bytes, threshold, expected }) => {
    expect(shouldSpillToFile(bytes, threshold)).toBe(expected);
  });

  it.each([
    { bytes: 0, threshold: 100 },
    { bytes: -1, threshold: 100 },
    { bytes: 200, threshold: -1 },
    { bytes: Number.NaN, threshold: 100 },
    { bytes: 200, threshold: Number.NaN },
    { bytes: Number.POSITIVE_INFINITY, threshold: 100 },
    { bytes: 200, threshold: Number.POSITIVE_INFINITY },
  ])("never spills on non-spillable input %#", ({ bytes, threshold }) => {
    expect(shouldSpillToFile(bytes, threshold)).toBe(false);
  });
});

describe("readBudgetedWorkspaceTextFile spill gate", () => {
  async function writeTempFile(content: string): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "tool-output-budget-"));
    const path = join(dir, "input.txt");
    await writeFile(path, content, "utf8");
    return { dir, path };
  }

  it("returns a non-truncated read inline without spilling", async () => {
    const { dir, path } = await writeTempFile("hello\n");
    try {
      const out = await readBudgetedWorkspaceTextFile(path, {
        maxFileBytes: 1_000_000,
        maxResponseBytes: 1_000,
        spillScope: { workItemId: "wi-1", toolCall: "read" },
      });
      expect(out.refused).toBeUndefined();
      expect(out).toMatchObject({ truncated: false });
      expect(out).not.toHaveProperty("spilled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a line-window cut inline without spilling even past the spill threshold", async () => {
    const body = `${"x".repeat(200)}\n`.repeat(2_000);
    const { dir, path } = await writeTempFile(body);
    try {
      const out = await readBudgetedWorkspaceTextFile(path, {
        maxFileBytes: 2_000_000,
        maxResponseBytes: 1_000_000,
        window: { startLine: 1, maxLines: 2 },
        spillScope: { workItemId: "wi-1", toolCall: "read" },
      });
      expect(out.refused).toBeUndefined();
      expect("spilled" in out && out.spilled).not.toBe(true);
      if (!("spilled" in out) && !out.refused) {
        expect(out.truncated).toBe(true);
        expect(out.truncationReason).toBe("line window limit exceeded");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an over-budget read inline when no spill scope is set", async () => {
    const body = `${"x".repeat(200)}\n`.repeat(2_000);
    const { dir, path } = await writeTempFile(body);
    try {
      const out = await readBudgetedWorkspaceTextFile(path, {
        maxFileBytes: 2_000_000,
        maxResponseBytes: 500,
      });
      expect(out.refused).toBeUndefined();
      expect("spilled" in out && out.spilled).not.toBe(true);
      if (!("spilled" in out) && !out.refused) {
        expect(out.truncated).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spillTextToSessionFile tail", () => {
  const scope = { workItemId: "wi-tail", toolCall: "read" };

  it("keeps a multibyte emoji tail valid UTF-8 at a mid-sequence cut", async () => {
    const text = `${"x".repeat(64)}😀é漢${"y".repeat(64)}`;
    const fullBytes = Buffer.byteLength(text, "utf8");
    const buf = Buffer.from(text, "utf8");
    const emojiStart = buf.indexOf(Buffer.from("😀", "utf8"));
    const tailBytes = buf.length - emojiStart - 2;
    const out = await spillTextToSessionFile(text, scope, { tailBytes });
    try {
      expect(out.tail).not.toContain("�");
      expect(Buffer.byteLength(out.tail, "utf8")).toBeLessThanOrEqual(tailBytes);
      expect(out.tail).toBe(
        buf.subarray(buf.length - Buffer.byteLength(out.tail, "utf8")).toString("utf8"),
      );
      expect(out.size).toBe(fullBytes);
      expect(await readFile(out.spillPath, "utf8")).toBe(text);
    } finally {
      await rm(out.spillPath, { force: true });
    }
  });

  it("keeps a CJK tail valid UTF-8 at a mid-sequence cut", async () => {
    const text = `${"a".repeat(64)}漢字テスト${"b".repeat(64)}`;
    const fullBytes = Buffer.byteLength(text, "utf8");
    const buf = Buffer.from(text, "utf8");
    const cjkStart = buf.indexOf(Buffer.from("漢", "utf8"));
    const tailBytes = buf.length - cjkStart - 1;
    const out = await spillTextToSessionFile(text, scope, { tailBytes });
    try {
      expect(out.tail).not.toContain("�");
      expect(Buffer.byteLength(out.tail, "utf8")).toBeLessThanOrEqual(tailBytes);
      expect(out.size).toBe(fullBytes);
      expect(await readFile(out.spillPath, "utf8")).toBe(text);
    } finally {
      await rm(out.spillPath, { force: true });
    }
  });

  it("returns the full text when tailBytes exceeds the buffer", async () => {
    const text = "short spill body\n";
    const out = await spillTextToSessionFile(text, scope, { tailBytes: 8_000 });
    try {
      expect(out.tail).toBe(text);
      expect(out.size).toBe(Buffer.byteLength(text, "utf8"));
      expect(out.truncated).toBe(true);
      expect(out.spilled).toBe(true);
    } finally {
      await rm(out.spillPath, { force: true });
    }
  });

  it("sanitizes empty scope segments into the spill filename", async () => {
    const out = await spillTextToSessionFile(
      "body\n",
      { workItemId: "", toolCall: "" },
      { tailBytes: 8_000 },
    );
    try {
      expect(basename(out.spillPath)).toMatch(/^pr-agent-read-spill-call-call-[0-9a-f]{8}\.txt$/);
      expect(out.path).toBe(out.spillPath);
      expect(await readFile(out.spillPath, "utf8")).toBe("body\n");
    } finally {
      await rm(out.spillPath, { force: true });
    }
  });

  it("replaces unsafe scope characters in the spill filename", async () => {
    const out = await spillTextToSessionFile(
      "body\n",
      { workItemId: "wi!!!/1", toolCall: "read file" },
      { tailBytes: 8_000 },
    );
    try {
      expect(basename(out.spillPath)).toMatch(
        /^pr-agent-read-spill-wi____1-read_file-[0-9a-f]{8}\.txt$/,
      );
    } finally {
      await rm(out.spillPath, { force: true });
    }
  });
});
