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
});
