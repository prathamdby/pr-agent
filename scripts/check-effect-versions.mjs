import fs from "node:fs";
import { createRequire } from "node:module";

const REQUIRED = {
  effect: "4.0.0",
  "@effect/platform-node": "4.0.0",
};

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const require = createRequire(import.meta.url);

const mismatches = Object.entries(REQUIRED)
  .map(([name, expected]) => {
    const actual = deps[name];
    if (!actual) return `${name}: missing (expected ${expected})`;
    if (actual !== expected) return `${name}: found ${actual}, expected ${expected}`;
    return null;
  })
  .filter(Boolean);

if (Object.hasOwn(deps, "@effect/platform")) {
  mismatches.push("@effect/platform: must not be a direct dependency");
}

function checkInstalled(name, expected, resolver = require) {
  try {
    const path = resolver.resolve(`${name}/package.json`);
    const installed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (installed.version !== expected) {
      mismatches.push(`${name}: installed ${installed.version}, expected ${expected}`);
    }
    return path;
  } catch {
    mismatches.push(`${name}: installed package metadata unavailable (expected ${expected})`);
    return undefined;
  }
}

checkInstalled("effect", REQUIRED.effect);
const nodeAdapter = checkInstalled("@effect/platform-node", REQUIRED["@effect/platform-node"]);
if (nodeAdapter) {
  const nodeRequire = createRequire(nodeAdapter);
  checkInstalled("effect", REQUIRED.effect, nodeRequire);
  checkInstalled("@effect/platform-node-shared", REQUIRED["@effect/platform-node"], nodeRequire);
}

if (mismatches.length > 0) {
  console.error("Effect dependency lock check failed:\n" + mismatches.join("\n"));
  process.exit(1);
}

console.log("Effect dependency lock check passed.");
