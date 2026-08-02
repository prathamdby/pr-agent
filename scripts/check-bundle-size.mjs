#!/usr/bin/env node
/**
 * Assert gzip size budgets on built site client assets under site/.output or site/dist.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.join(process.cwd(), "site");
const BUDGETS = {
  // Total gzip of JS assets (bytes). Raise only with intentional budget PRs.
  totalJsGzip: 900_000,
  maxSingleJsGzip: 450_000,
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const candidates = [
  path.join(ROOT, ".output", "public"),
  path.join(ROOT, "dist", "client"),
  path.join(ROOT, "dist"),
  path.join(ROOT, ".vercel", "output", "static"),
].filter((d) => fs.existsSync(d));

if (candidates.length === 0) {
  console.error("No site build output found. Run site:build first.");
  process.exit(1);
}

const jsFiles = candidates.flatMap((dir) => walk(dir)).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error(`No .js assets under: ${candidates.join(", ")}`);
  process.exit(1);
}

let total = 0;
let maxSingle = 0;
let maxPath = "";
for (const file of jsFiles) {
  const gz = zlib.gzipSync(fs.readFileSync(file)).byteLength;
  total += gz;
  if (gz > maxSingle) {
    maxSingle = gz;
    maxPath = path.relative(process.cwd(), file);
  }
}

const failures = [];
if (total > BUDGETS.totalJsGzip) {
  failures.push(`total JS gzip ${total} > budget ${BUDGETS.totalJsGzip}`);
}
if (maxSingle > BUDGETS.maxSingleJsGzip) {
  failures.push(`largest JS gzip ${maxSingle} (${maxPath}) > budget ${BUDGETS.maxSingleJsGzip}`);
}

if (failures.length) {
  console.error(["Bundle size check failed:", ...failures.map((f) => `- ${f}`)].join("\n"));
  process.exit(1);
}
console.log(
  `Bundle size check passed (files=${jsFiles.length}, totalGzip=${total}, maxGzip=${maxSingle}).`,
);
