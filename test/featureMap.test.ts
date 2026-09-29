import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("feature map", () => {
  it("matches the generator output (do not hand-edit docs/feature-map.md)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feature-map-"));
    const out = path.join(tmp, "feature-map.md");
    execFileSync(process.execPath, ["scripts/gen-feature-map.mjs", out], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    execFileSync(path.join(process.cwd(), "node_modules", ".bin", "oxfmt"), [out], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const expected = fs.readFileSync(path.join(process.cwd(), "docs", "feature-map.md"), "utf8");
    const actual = fs.readFileSync(out, "utf8");
    expect(actual).toBe(expected);
  });
});
