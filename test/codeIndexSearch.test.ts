import { describe, expect, it, vi } from "vitest";
import { mapSearchRowsToHints, previewForChunk } from "../src/codeIndex/search.js";

describe("codeIndex search", () => {
  it("maps FTS rows to hints with optional preview", () => {
    const hints = mapSearchRowsToHints(
      [
        {
          path: "src/a.ts",
          start_line: 4,
          end_line: 8,
          content: "export function alpha() {\n  return 1;\n}",
          content_hash: Buffer.from("abc"),
        },
      ],
      () => true,
    );

    expect(hints).toEqual([
      {
        path: "src/a.ts",
        startLine: 4,
        endLine: 8,
        preview: previewForChunk("export function alpha() {\n  return 1;\n}"),
      },
    ]);
  });

  it("omits preview when workspace hash verification fails", () => {
    const hints = mapSearchRowsToHints(
      [
        {
          path: "src/a.ts",
          start_line: 1,
          end_line: 2,
          content: "stale",
          content_hash: Buffer.from("abc"),
        },
      ],
      () => false,
    );

    expect(hints[0]).toEqual({
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
    });
    expect(hints[0]).not.toHaveProperty("preview");
  });

  it("queries FTS via pool", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          path: "src/a.ts",
          start_line: 1,
          end_line: 3,
          content: "export function x() {}",
          content_hash: Buffer.alloc(32),
        },
      ],
    });
    const pool = { query } as never;
    const { searchCodeIndexFts } = await import("../src/codeIndex/search.js");
    const rows = await searchCodeIndexFts(pool, "snap-1", "function", 5);
    expect(rows).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("plainto_tsquery"), [
      "snap-1",
      "function",
      20,
    ]);
  });
});
