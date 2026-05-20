import fs from "node:fs";

const REQUIRED = {
  effect: "3.21.2",
  "@effect/platform": "0.96.1",
  "@effect/platform-node": "0.106.0",
};

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

const mismatches = Object.entries(REQUIRED)
  .map(([name, expected]) => {
    const actual = deps[name];
    if (!actual) return `${name}: missing (expected ${expected})`;
    if (actual !== expected) return `${name}: found ${actual}, expected ${expected}`;
    return null;
  })
  .filter(Boolean);

if (mismatches.length > 0) {
  console.error("Effect dependency lock check failed:\n" + mismatches.join("\n"));
  process.exit(1);
}

console.log("Effect dependency lock check passed.");
