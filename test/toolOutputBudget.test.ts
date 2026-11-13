import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../src/settings/index.ts";
import {
  readTextWithOutputBudget,
  shouldSpillToFile,
} from "../src/agent/tools/toolOutputBudget.ts";
import {
  readBudgetedWorkspaceTextFile,
  spillTextToSessionFile,
} from "../src/agent/tools/readWorkspaceTextFile.ts";

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
    const out = readTextWithOutputBudget(text, 6);
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

  it("keeps a bounded prefix of an over-long line with an inline marker", () => {
    const longLine = "x".repeat(OVER_LIMIT);
    const text = `short\n${longLine}\ntail\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    const expectedPrefix = "x".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(
      `short\n${expectedPrefix}… [line 2 clamped: 1 of ${OVER_LIMIT} characters elided]\ntail\n`,
    );
    expect(out.endLine).toBe(3);
    expect(out.clampedLines).toEqual([2]);
    expect(out.note).toContain("2");
    expect(out.note).toContain("startLine 2, maxLines 1");
  });

  it.each([undefined, { startLine: 1, maxLines: 2 }])(
    "keeps an exact-limit line whole and clamps only above the limit with window %j",
    (window) => {
      const line = "x".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS);
      const exact = readTextWithOutputBudget(line, 128_000, window);
      expect(exact.content).toBe(line);
      expect(exact.clampedLines).toBeUndefined();

      const over = readTextWithOutputBudget(`${line}x`, 128_000, window);
      expect(over.content).toBe(`${line}… [line 1 clamped: 1 of ${OVER_LIMIT} characters elided]`);
      expect(over.clampedLines).toEqual([1]);
    },
  );

  it.each([undefined, { startLine: 2, maxLines: 2 }])(
    "advances past a whole line at either newline boundary with window %j",
    (window) => {
      const text = "aaaa\nbbbb\ndddd\n";
      const startLine = window?.startLine ?? 1;
      for (const budget of [0, 4, 5]) {
        const out = readTextWithOutputBudget(text, budget, window);
        const resumeStartLine = budget === 0 ? startLine : startLine + 1;
        expect(out.truncated).toBe(true);
        expect(out.endLine).toBe(resumeStartLine - 1);
        expect(out.clampedLines).toBeUndefined();
        expect(out.resumeStartLine).toBe(resumeStartLine);
        expect(out.note).toBe(
          `Truncated by the response byte budget at line ${out.endLine} of 3. Resume with startLine ${resumeStartLine}.`,
        );
        const resumed = readTextWithOutputBudget(text, 128_000, {
          startLine: out.resumeStartLine,
        });
        expect(resumed.content).toBe(
          text
            .trimEnd()
            .split("\n")
            .slice(resumeStartLine - 1)
            .join("\n"),
        );
      }
    },
  );

  it("reports no clamped lines when nothing was elided", () => {
    const out = readTextWithOutputBudget("a\nb\n", 128_000);
    expect(out.clampedLines).toBeUndefined();
  });

  it("keeps marker line numbers absolute under a multi-line window", () => {
    const longLine = "y".repeat(OVER_LIMIT);
    const text = `a\nb\nc\n${longLine}\ne\n`;
    const out = readTextWithOutputBudget(text, 128_000, { startLine: 4, maxLines: 2 });
    expect(out.content).toBe(
      `${"y".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS)}… [line 4 clamped: 1 of ${OVER_LIMIT} characters elided]\ne`,
    );
    expect(out.startLine).toBe(4);
    expect(out.endLine).toBe(5);
    expect(out.truncated).toBe(false);
    expect(out.clampedLines).toEqual([4]);
  });

  it("returns a single long line whole when maxLines is 1", () => {
    const lines = Array.from({ length: 320 }, (_, index) =>
      index === 313 ? "z".repeat(7_537) : `line-${index + 1}`,
    );
    const out = readTextWithOutputBudget(`${lines.join("\n")}\n`, 128_000, {
      startLine: 314,
      maxLines: 1,
    });
    expect(out.content).toBe("z".repeat(7_537));
    expect(out.startLine).toBe(314);
    expect(out.endLine).toBe(314);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("line window limit exceeded");
    expect(out.resumeStartLine).toBe(315);
    expect(out.clampedLines).toBeUndefined();
  });

  it("clamps a mega-line to a prefix before the byte budget so surrounding lines survive", () => {
    const text = `${"m".repeat(500_000)}\nafter\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(
      `${"m".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS)}… [line 1 clamped: ${500_000 - LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS} of 500000 characters elided]\nafter\n`,
    );
    expect(out.clampedLines).toEqual([1]);
    expect(out.note).toContain("startLine 1, maxLines 1");
  });

  it("caps a single mega-line read at the byte budget and advances resumeStartLine", () => {
    const text = `${"m".repeat(500_000)}\nafter\n`;
    const out = readTextWithOutputBudget(text, 128_000, { startLine: 1, maxLines: 1 });
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(128_000);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("response byte budget exceeded");
    expect(out.clampedLines).toEqual([1]);
    expect(out.resumeStartLine).toBe(2);
    expect(out.note).toContain(String(out.content.length));
    expect(out.note).toContain("500000");
    expect(out.note).toContain("readWorkspaceFile");
  });

  it("reports an unreachable tail without a resume line when the last line is byte-capped", () => {
    const out = readTextWithOutputBudget(`before\n${"m".repeat(500_000)}`, 64, {
      startLine: 2,
      maxLines: 1,
    });
    expect(out.content).toBe("m".repeat(64));
    expect(out).toMatchObject({
      startLine: 2,
      endLine: 2,
      truncated: true,
      truncationReason: "response byte budget exceeded",
      returnedBytes: 64,
      clampedLines: [2],
    });
    expect(out.resumeStartLine).toBeUndefined();
    expect(out.note).toContain("cannot be reached with readWorkspaceFile");
  });

  it("steps back at a surrogate pair boundary when clamping a long line", () => {
    const prefix = "a".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS - 1);
    const text = `${prefix}😀tail\n`;
    const out = readTextWithOutputBudget(text, 128_000);
    expect(out.clampedLines).toEqual([1]);
    expect(out.content).toBe(
      `${prefix}… [line 1 clamped: 6 of ${prefix.length + 6} characters elided]\n`,
    );
    expect(Buffer.from(out.content, "utf8").toString("utf8")).toBe(out.content);
    expect(out.content).not.toContain("\uFFFD");
  });

  it("keeps a single-line byte-budget cut valid UTF-8 inside a 3-byte character", () => {
    const line = "€".repeat(50_000);
    const out = readTextWithOutputBudget(`${line}\nafter\n`, 128_000, {
      startLine: 1,
      maxLines: 1,
    });
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("response byte budget exceeded");
    expect(Buffer.byteLength(out.content, "utf8")).toBe(127_998);
    expect(out.content).not.toContain("\uFFFD");
    expect(Buffer.from(out.content, "utf8").toString("utf8")).toBe(out.content);
    expect(out.clampedLines).toEqual([1]);
  });

  it("records a mid-line byte-budget cut in clampedLines and omits exact line-boundary cuts", () => {
    const windowedMidCut = readTextWithOutputBudget("aaaa\nbbbb\ndddd\neeee\n", 7, {
      startLine: 2,
      maxLines: 3,
    });
    expect(windowedMidCut.clampedLines).toEqual([3]);

    const wholeMidCut = readTextWithOutputBudget("aaaa\nbbbb\ndddd\n", 6);
    expect(wholeMidCut.clampedLines).toEqual([2]);

    const windowedAfterNewline = readTextWithOutputBudget("aaaa\nbbbb\ndddd\n", 5, {
      startLine: 1,
      maxLines: 3,
    });
    expect(windowedAfterNewline.content).toBe("aaaa\n");
    expect(windowedAfterNewline.clampedLines).toBeUndefined();

    const windowedBeforeNewline = readTextWithOutputBudget("aaaa\nbbbb\ndddd\n", 4, {
      startLine: 1,
      maxLines: 3,
    });
    expect(windowedBeforeNewline.content).toBe("aaaa");
    expect(windowedBeforeNewline.clampedLines).toBeUndefined();

    const wholeAfterNewline = readTextWithOutputBudget("aaaa\nbbbb\ndddd\n", 5);
    expect(wholeAfterNewline.content).toBe("aaaa\n");
    expect(wholeAfterNewline.clampedLines).toBeUndefined();
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
