import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function extractMdLinks(md: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const target = m[1].split("#")[0]?.split(" ")[0]?.trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://")) continue;
    links.push(target);
  }
  return links;
}

describe("AGENTS.md freshness", () => {
  it("markdown links in AGENTS.md and CONTEXT.md resolve to existing files", () => {
    for (const rel of ["AGENTS.md", "CONTEXT.md"]) {
      const file = path.join(ROOT, rel);
      const md = fs.readFileSync(file, "utf8");
      const dir = path.dirname(file);
      for (const link of extractMdLinks(md)) {
        const resolved = path.resolve(dir, link);
        expect(fs.existsSync(resolved), `${rel} link missing: ${link}`).toBe(true);
      }
    }
  });

  it("package.json scripts referenced by ops/dev docs exist", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const scripts = new Set(Object.keys(pkg.scripts));
    const docs = ["docs/operations.md", "docs/development.md", "README.md"]
      .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8"))
      .join("\n");
    const mentioned = new Set<string>();
    // Match `nub run <script>` but not `nub run --node ...` flags.
    const re = /nub run (?!--)([a-zA-Z][a-zA-Z0-9:_-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(docs))) {
      mentioned.add(m[1]);
    }
    for (const name of mentioned) {
      if (name.includes("...")) continue;
      expect(scripts.has(name), `docs mention missing script: ${name}`).toBe(true);
    }
  });
});
