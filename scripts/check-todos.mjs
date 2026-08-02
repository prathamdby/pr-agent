#!/usr/bin/env node
/**
 * Fail on issue markers that are not linked to a GitHub issue number.
 * Accepted forms: TODO(#123) and FIXME(#123).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ROOTS = ["src", "test", "scripts", "site"].map((d) => path.join(ROOT, d));
const EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".md"]);
const SKIP_DIR = new Set(["node_modules", "dist", "coverage", ".output", ".vercel", "out"]);
const SKIP_FILES = new Set([path.join(ROOT, "scripts", "check-todos.mjs")]);

// Match TODO/FIXME only as whole markers, optional (#n)
const MARKER = /\b(TODO|FIXME)(\(#(\d+)\))?/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

const bad = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (SKIP_FILES.has(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      MARKER.lastIndex = 0;
      let m;
      while ((m = MARKER.exec(line))) {
        if (!m[2]) {
          bad.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    });
  }
}

if (bad.length) {
  console.error(
    ["Unlinked issue markers (use TODO(#123) or FIXME(#123)):", ...bad.map((b) => `- ${b}`)].join(
      "\n",
    ),
  );
  process.exit(1);
}
console.log("Issue-marker link check passed.");
