import { describe, expect, it } from "vitest";
import {
  buildSymbolIndex,
  formatSymbolIndexStatusLine,
  isIndexableSourcePath,
  querySymbolIndex,
  symbolIndexStatus,
} from "../src/prWorkspace/symbolIndex.js";

describe("symbolIndex", () => {
  it("indexes TypeScript function definitions", async () => {
    const index = await buildSymbolIndex(["src/foo.ts"], async (path) => {
      if (path === "src/foo.ts") return "export function foo() {\n  return 1;\n}\n";
      return null;
    });

    expect(querySymbolIndex(index, "foo")).toEqual([
      { path: "src/foo.ts", line: 1, kind: "function" },
    ]);
    expect(symbolIndexStatus(index)).toEqual({ available: true, symbolCount: 1 });
    expect(formatSymbolIndexStatusLine(symbolIndexStatus(index))).toBe(
      "Symbol index: built for 1 symbols.",
    );
  });

  it("indexes Python class and function definitions", async () => {
    const index = await buildSymbolIndex(["pkg/module.py"], async (path) => {
      if (path === "pkg/module.py") {
        return ["class Widget:", "    def foo(self):", "        pass", ""].join("\n");
      }
      return null;
    });

    expect(querySymbolIndex(index, "Widget")).toEqual([
      { path: "pkg/module.py", line: 1, kind: "class" },
    ]);
    expect(querySymbolIndex(index, "foo")).toEqual([
      { path: "pkg/module.py", line: 2, kind: "function" },
    ]);
  });

  it("skips non-indexable paths and files missing from checkout", async () => {
    const index = await buildSymbolIndex(
      ["src/on-disk.ts", "src/missing.ts", "README.md"],
      async (path) => {
        if (path === "src/on-disk.ts") return "function foo() {}\n";
        return null;
      },
    );

    expect(querySymbolIndex(index, "foo")).toEqual([
      { path: "src/on-disk.ts", line: 1, kind: "function" },
    ]);
    expect(isIndexableSourcePath("README.md")).toBe(false);
    expect(isIndexableSourcePath("src/a.ts")).toBe(true);
  });

  it("reports unavailable status for a missing index", () => {
    expect(symbolIndexStatus(null)).toEqual({ available: false });
    expect(formatSymbolIndexStatusLine({ available: false })).toBe("Symbol index: unavailable.");
    expect(querySymbolIndex(null, "foo")).toEqual([]);
  });

  it("keeps max-symbols path order with concurrent reads", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const readOrder: string[] = [];
    const index = await buildSymbolIndex(
      paths,
      async (path) => {
        readOrder.push(path);
        const id = path.match(/f(\d+)\.ts$/)?.[1] ?? "xx";
        await new Promise((r) => setTimeout(r, id === "10" ? 15 : 1));
        return `export function sym_${id}() {}\n`;
      },
      { maxSymbols: 5, readConcurrency: 8 },
    );

    // First chunk (8) is fully read; further chunks stop after the symbol cap.
    expect(readOrder.length).toBe(8);
    expect(index.symbolCount).toBe(5);
    expect(querySymbolIndex(index, "sym_00")).toEqual([
      { path: "src/f00.ts", line: 1, kind: "function" },
    ]);
    expect(querySymbolIndex(index, "sym_04")).toEqual([
      { path: "src/f04.ts", line: 1, kind: "function" },
    ]);
    expect(querySymbolIndex(index, "sym_05")).toEqual([]);
    expect(querySymbolIndex(index, "sym_10")).toEqual([]);
  });
});
