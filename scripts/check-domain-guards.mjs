import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (msg) => failures.push(msg);

const BANNED_PACKAGES = [
  {
    name: "knip",
    reason:
      "Architecture and import edges stay in test/architectureRules.test.ts; knip failed workspace resolution and the release-age gate.",
  },
  {
    name: "zod",
    reason: "Valibot is the single runtime validation library; keep zod out of dependencies.",
  },
  {
    name: "@cursor/sdk",
    reason: "The dual-runtime Cursor provider was retired for the single Pi-native runtime seam.",
  },
  {
    name: "@earendil-works/pi-coding-agent",
    reason:
      "Agent sessions run on @earendil-works/pi-agent-core and @earendil-works/pi-ai without coding-agent.",
  },
  {
    name: "pg",
    reason: "Durable state runs on node:sqlite under SQLITE_DIR; Postgres was retired.",
  },
  {
    name: "pg-boss",
    reason: "Durable execution runs on Pi Durable + SQLite dispatcher; pg-boss was retired.",
  },
];

const DISABLED_OXLINT_RULES = [
  {
    rule: "landmines-testing/no-test-doubles",
    reason:
      "Seam tests replace runAgentLoop and PrSurface factories, and isolated reviewers use createFakePiSession.",
  },
  {
    rule: "landmines-structure/colocated-tests",
    reason: "Tests live under root test/, and new test files are opt-in.",
  },
  {
    rule: "landmines-structure/test-file-names",
    reason: "The rule rejects src/prompts/tests/, which owns the tests specialist role.",
  },
];

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(relPath) {
  const absPath = path.join(ROOT, relPath);
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (error) {
    fail(`cannot read ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      fail(`${relPath} must contain a JSON object`);
      return null;
    }
    return parsed;
  } catch (error) {
    fail(`invalid JSON in ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function checkManifestDependencies(manifestPath, manifest) {
  for (const section of DEPENDENCY_SECTIONS) {
    if (!Object.hasOwn(manifest, section)) continue;
    const deps = manifest[section];
    if (!isPlainObject(deps)) {
      fail(`${manifestPath} ${section} must be a JSON object`);
      continue;
    }
    for (const banned of BANNED_PACKAGES) {
      if (Object.hasOwn(deps, banned.name)) {
        fail(`banned package ${banned.name} in ${manifestPath} ${section}: ${banned.reason}`);
      }
    }
  }
}

function checkBannedPackages() {
  const rootManifest = readJsonObject("package.json");
  if (rootManifest === null) return;
  const manifestPaths = ["package.json"];
  if (Object.hasOwn(rootManifest, "workspaces")) {
    if (
      !Array.isArray(rootManifest.workspaces) ||
      rootManifest.workspaces.some((ws) => typeof ws !== "string" || ws.length === 0)
    ) {
      fail("package.json workspaces must be an array of non-empty directory strings");
    } else {
      for (const ws of rootManifest.workspaces) {
        manifestPaths.push(path.posix.join(ws, "package.json"));
      }
    }
  }
  for (const manifestPath of manifestPaths) {
    const manifest = manifestPath === "package.json" ? rootManifest : readJsonObject(manifestPath);
    if (manifest !== null) checkManifestDependencies(manifestPath, manifest);
  }
}

function checkDisabledOxlintRules() {
  const oxlintConfig = readJsonObject(".oxlintrc.json");
  if (oxlintConfig === null) return;
  if (!isPlainObject(oxlintConfig.rules)) {
    fail(".oxlintrc.json rules must be a JSON object");
  } else {
    for (const entry of DISABLED_OXLINT_RULES) {
      if (
        !Object.hasOwn(oxlintConfig.rules, entry.rule) ||
        oxlintConfig.rules[entry.rule] !== "off"
      ) {
        fail(`.oxlintrc.json must set ${entry.rule} to "off": ${entry.reason}`);
      }
    }
  }
  if (!Object.hasOwn(oxlintConfig, "overrides")) return;
  if (!Array.isArray(oxlintConfig.overrides)) {
    fail(".oxlintrc.json overrides must be an array");
    return;
  }
  for (const [index, override] of oxlintConfig.overrides.entries()) {
    if (!isPlainObject(override)) {
      fail(`.oxlintrc.json overrides[${index}] must be a JSON object`);
      continue;
    }
    if (!Object.hasOwn(override, "rules")) continue;
    if (!isPlainObject(override.rules)) {
      fail(`.oxlintrc.json overrides[${index}].rules must be a JSON object`);
      continue;
    }
    for (const entry of DISABLED_OXLINT_RULES) {
      if (Object.hasOwn(override.rules, entry.rule) && override.rules[entry.rule] !== "off") {
        fail(`.oxlintrc.json overrides[${index}] must not enable ${entry.rule}: ${entry.reason}`);
      }
    }
  }
}

const envKeys = fs.readFileSync(path.join(ROOT, "src", "settings", "envKeys.ts"), "utf8");
const llms = fs.readFileSync(path.join(ROOT, "site", "lib", "llmsKnowledge.ts"), "utf8");
for (const match of envKeys.matchAll(/"(FEATURE_[A-Z_]+)"/g)) {
  if (!llms.includes(match[1]))
    fail(`site drift: ${match[1]} missing from site/lib/llmsKnowledge.ts`);
}

checkBannedPackages();
checkDisabledOxlintRules();

if (failures.length > 0) {
  console.error(`Domain guard failures:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Domain guards passed.");
