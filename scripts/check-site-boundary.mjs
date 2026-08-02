#!/usr/bin/env node
/**
 * Assert site client modules never import nitro / node server-only packages.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "site");
const CLIENT_DIRS = ["components", "lib"].map((d) => path.join(ROOT, d));
const FORBIDDEN = [
  /^nitro(\/|$)/,
  /^node:/,
  /^fs$/,
  /^path$/,
  /^child_process$/,
  /^net$/,
  /^http$/,
  /^https$/,
  /^crypto$/,
  /^stream$/,
  /^os$/,
  /^worker_threads$/,
];

// Server-only files under site may import node; client surfaces must not.
const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, "utf8");
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1] || m[2];
      if (!spec || spec.startsWith(".") || spec.startsWith("@/")) continue;
      if (FORBIDDEN.some((re) => re.test(spec))) {
        hits.push(`${path.relative(process.cwd(), file)} imports forbidden '${spec}'`);
      }
    }
  }
}

if (hits.length) {
  console.error(["Site boundary check failed:", ...hits.map((h) => `- ${h}`)].join("\n"));
  process.exit(1);
}
console.log("Site boundary check passed.");
