import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkFileContent, chunkFiles } from "../src/codeIndex/chunker.js";

describe("codeIndex chunker", () => {
  it("splits TypeScript files on function boundaries", () => {
    const content = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
    ].join("\n");

    const chunks = chunkFileContent("src/a.ts", content);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      path: "src/a.ts",
      startLine: 1,
      endLine: 4,
      symbolNames: ["alpha"],
    });
    expect(chunks[1]).toMatchObject({
      startLine: 5,
      endLine: 7,
      symbolNames: ["beta"],
    });
    expect(chunks[0]?.content).toContain("return 1");
  });

  it("splits Python files on def boundaries", () => {
    const content = ["def one():", "  pass", "", "def two():", "  pass"].join("\n");
    const chunks = chunkFileContent("pkg/mod.py", content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.symbolNames).toEqual(["one"]);
    expect(chunks[1]?.symbolNames).toEqual(["two"]);
  });

  it("caps total chunks across files", () => {
    const files = [
      { path: "a.ts", content: "export function a() {}\nexport function b() {}" },
      { path: "b.ts", content: "export function c() {}\nexport function d() {}" },
    ];
    const { chunks, truncated } = chunkFiles(files, 2);
    expect(chunks).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("splits TypeScript methods on supported modifiers and indentation", () => {
    const content = [
      "class Holder {",
      "  public alpha() {",
      "    return 1;",
      "  }",
      "",
      "  private static async beta(): number {",
      "    return 2;",
      "  }",
      "",
      "  protected function gamma() {",
      "    return 3;",
      "  }",
      "}",
    ].join("\n");

    const chunks = chunkFileContent("src/holder.ts", content);

    expect(chunks.map((chunk) => chunk.symbolNames)).toEqual([
      ["Holder"],
      ["alpha"],
      ["beta"],
      ["gamma"],
    ]);
    expect(chunks.map((chunk) => ({ startLine: chunk.startLine, endLine: chunk.endLine }))).toEqual(
      [
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 5 },
        { startLine: 6, endLine: 9 },
        { startLine: 10, endLine: 13 },
      ],
    );
    expect(chunks[1]?.content).toContain("return 1");
    expect(chunks[2]?.content).toContain("return 2");
  });

  it("leaves comments, blanks, and ordinary lines as one chunk without symbols", () => {
    const content = [
      "",
      "// public leftover() {",
      "const value = 1;",
      "  /* private static async leftover() { */",
    ].join("\n");

    const chunks = chunkFileContent("src/plain.ts", content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      startLine: 1,
      endLine: 4,
      symbolNames: [],
      content,
    });
  });

  it("keeps empty input as one empty chunk", () => {
    const chunks = chunkFileContent("src/empty.ts", "");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      path: "src/empty.ts",
      startLine: 1,
      endLine: 1,
      symbolNames: [],
      content: "",
    });
    expect(chunks[0]?.contentHash).toEqual(createHash("sha256").update("").digest());
  });

  it("keeps Python class and async def boundaries", () => {
    const content = ["class Box:", "  pass", "", "async def run():", "  pass"].join("\n");
    const chunks = chunkFileContent("pkg/box.py", content);
    expect(chunks.map((chunk) => chunk.symbolNames)).toEqual([["Box"], ["run"]]);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3 });
    expect(chunks[1]).toMatchObject({ startLine: 4, endLine: 5 });
  });

  it("hashes identical content the same way and skips non-source paths", () => {
    const content = "export function hashed() {\n  return 1;\n}";
    const [first] = chunkFileContent("src/hash.ts", content);
    const [second] = chunkFileContent("src/hash.ts", content);
    expect(first?.contentHash).toEqual(createHash("sha256").update(content).digest());
    expect(second?.contentHash).toEqual(first?.contentHash);

    const { chunks, truncated } = chunkFiles(
      [
        { path: "README.md", content: "export function ignored() {}" },
        { path: "src/kept.ts", content },
      ],
      100_000,
    );
    expect(truncated).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.path).toBe("src/kept.ts");
    expect(chunks[0]?.contentHash).toEqual(first?.contentHash);
  });

  it("keeps method-boundary cost from doubling into a fourfold jump twice", () => {
    const measure = (spaces: number): number => {
      const content = `${" ".repeat(spaces)}// comment without a method\n`;
      const repeats = 8;
      for (let i = 0; i < 3; i++) {
        for (let r = 0; r < repeats; r++) chunkFileContent("src/slow.ts", content);
      }
      const samples: number[] = [];
      for (let i = 0; i < 11; i++) {
        const start = performance.now();
        for (let r = 0; r < repeats; r++) chunkFileContent("src/slow.ts", content);
        samples.push((performance.now() - start) / repeats);
      }
      samples.sort((a, b) => a - b);
      return samples[5] ?? 0;
    };

    const twoKb = measure(2031);
    const fourKb = measure(4031);
    const eightKb = measure(8031);
    const first = fourKb / Math.max(twoKb, Number.EPSILON);
    const second = eightKb / Math.max(fourKb, Number.EPSILON);

    expect(first >= 3.2 && second >= 3.2).toBe(false);
    expect(eightKb / Math.max(twoKb, Number.EPSILON)).toBeLessThan(10);
  });
});
