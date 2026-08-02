#!/usr/bin/env node
/**
 * Enforce backend file-name conventions:
 * - src modules: camelCase (or PascalCase for rare types files)
 * - tests: *.test.ts (optionally *.extra.test.ts)
 * - constants modules: *Constants.ts or constants.ts
 * - setup helpers may use kebab-case segments (allowlist)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const TEST = path.join(ROOT, "test");

const ALLOW_BASENAMES = new Set([
  "constants.ts",
  "index.ts",
  "types.ts",
  "common.ts",
  "defaults.ts",
  "envKeys.ts",
  "featureModes.ts",
]);

const ALLOW_TEST_BASENAMES = new Set(["ciStatus-mock.ts", "operationIntent-memory.ts", "evlog.ts"]);

const CAMEL_OR_PASCAL = /^[a-z][a-zA-Z0-9]*\.ts$|^[A-Z][a-zA-Z0-9]*\.ts$/;
const CONSTANTS = /^[a-z][a-zA-Z0-9]*Constants\.ts$/;
const TEST_FILE = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\.test\.ts$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const errors = [];

for (const file of walk(SRC)) {
  const base = path.basename(file);
  if (ALLOW_BASENAMES.has(base)) continue;
  if (CONSTANTS.test(base) || CAMEL_OR_PASCAL.test(base)) continue;
  errors.push(
    `src naming: ${path.relative(ROOT, file)} (expect camelCase module or *Constants.ts)`,
  );
}

for (const file of walk(TEST)) {
  const base = path.basename(file);
  const rel = path.relative(ROOT, file);
  if (ALLOW_TEST_BASENAMES.has(base)) continue;
  if (rel.startsWith(`test${path.sep}setup${path.sep}`) && CAMEL_OR_PASCAL.test(base)) continue;
  if (TEST_FILE.test(base)) continue;
  if (CAMEL_OR_PASCAL.test(base) && !base.includes(".test.")) {
    continue;
  }
  errors.push(`test naming: ${rel} (expect *.test.ts or allowed setup helper)`);
}

if (errors.length) {
  console.error(["File naming policy failed:", ...errors.map((e) => `- ${e}`)].join("\n"));
  process.exit(1);
}
console.log("File naming policy check passed.");
