import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Pi-native runtime dependency inventory", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    pnpm?: { onlyBuiltDependencies?: string[] };
  };

  it("removes Cursor SDK, MCP SDK, and sqlite3 build approval", () => {
    expect(pkg.dependencies?.["@cursor/sdk"]).toBeUndefined();
    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(pkg.pnpm?.onlyBuiltDependencies ?? []).not.toContain("sqlite3");
  });

  it("has no Cursor provider source tree", () => {
    expect(existsSync("src/agent/providers/cursor")).toBe(false);
    expect(existsSync("src/settings/cursorConstants.ts")).toBe(false);
  });
});
