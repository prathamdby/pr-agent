import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countEscapeCalls } from "./count-escape-calls.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "baselines", "static-baseline.json");
const BOOTSTRAP = process.argv.includes("--bootstrap");

function countOxRule(rule, lintCode, scope) {
  // NOTE: --deny makes oxlint exit 1 on hits, and --format json emits
  // JSONL (one object per line) instead of a JSON document. Handle both.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8"));
  for (const override of config.overrides ?? []) {
    if (override.rules) delete override.rules[rule];
  }
  const configPath = path.join(ROOT, `.oxlint-count-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config), { flag: "wx" });
  let raw;
  try {
    raw = execFileSync(
      path.join(
        ROOT,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "oxlint.cmd" : "oxlint",
      ),
      ["--format", "json", "-c", configPath, "--deny", rule, ...scopeRoots(scope)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (e) {
    // A hard oxlint failure (missing binary, bad flag, broken config) must
    // fail the gate, never read as zero violations.
    const stdout = e.stdout ?? "";
    if (typeof stdout !== "string" || stdout.trim().length === 0) throw e;
    raw = stdout;
  } finally {
    fs.unlinkSync(configPath);
  }
  let diagnostics;
  const trimmed = raw.trim();
  // oxlint prints nothing when the scope is clean: an empty success is a
  // valid zero, but only when the binary itself succeeded above. The catch
  // path rethrows on empty stdout, so reaching here with "" means clean.
  if (trimmed.length === 0) return 0;
  if (trimmed.startsWith("{")) {
    diagnostics = JSON.parse(trimmed).diagnostics;
  } else {
    diagnostics = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  return diagnostics.filter((d) => d.code === lintCode).length;
}

function scopeRoots(scope) {
  if (scope === "src/**") return ["src"];
  if (scope === "test/**") return ["test"];
  return ["."];
}

function countPattern(pattern, scope, flags) {
  const roots = scopeRoots(scope).map((r) => path.join(ROOT, r));
  const out = execSync(
    `rg --no-messages -o --no-filename ${flags} -e ${JSON.stringify(pattern)} ${roots.map((r) => JSON.stringify(r)).join(" ")} || true`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return out.split("\n").filter((line) => line.length > 0).length;
}

/**
 * Rules are data: each row names what to count, where, and how.
 * Lint rules count oxlint JSON diagnostics by code; source rules count
 * regex hits. tsc is never baselined: it has no suppression path, so its
 * stock stays zero by construction.
 */
const RULES = [
  {
    id: "no-unsafe-type-assertion(src)",
    kind: "oxlint-deny",
    rule: "typescript/no-unsafe-type-assertion",
    lintCode: "typescript(no-unsafe-type-assertion)",
    scope: "src/**",
  },
  {
    id: "no-unsafe-type-assertion(test)",
    kind: "oxlint-deny",
    rule: "typescript/no-unsafe-type-assertion",
    lintCode: "typescript(no-unsafe-type-assertion)",
    scope: "test/**",
  },
  {
    id: "explicit-any(src)",
    kind: "oxlint-deny",
    rule: "typescript/no-explicit-any",
    lintCode: "typescript(no-explicit-any)",
    scope: "src/**",
  },
  {
    id: "non-null-assertion(src)",
    kind: "oxlint-deny",
    rule: "typescript/no-non-null-assertion",
    lintCode: "typescript(no-non-null-assertion)",
    scope: "src/**",
  },
  {
    id: "no-console(src)",
    kind: "pattern",
    pattern: "console\\.(log|error|warn|info|debug|trace)\\s*\\(",
    scope: "src/**",
    flags: "",
  },
  {
    id: "lint-suppressions(src)",
    kind: "pattern",
    pattern: "(oxlint|eslint)-disable",
    scope: "src/**",
    flags: "",
  },
  {
    id: "lint-suppressions(test)",
    kind: "pattern",
    pattern: "(oxlint|eslint)-disable",
    scope: "test/**",
    flags: "",
  },
  {
    id: "escape-calls",
    kind: "escape-calls",
    scope: "src/**",
  },
  { id: "as-any", kind: "pattern", pattern: "\\bas\\s+any\\b", scope: "src/**", flags: "" },
  {
    id: "ts-ignore",
    kind: "pattern",
    pattern: "@ts-ignore",
    scope: "src/**",
    flags: "--fixed-strings",
  },
  {
    id: "ts-expect-error",
    kind: "pattern",
    pattern: "@ts-expect-error",
    scope: "src/**",
    flags: "--fixed-strings",
  },
];

function currentCounts() {
  const counts = {};
  for (const row of RULES) {
    counts[row.id] =
      row.kind === "escape-calls"
        ? countEscapeCalls(path.join(ROOT, "src"))
        : row.kind === "oxlint-deny"
          ? countOxRule(row.rule, row.lintCode, row.scope)
          : countPattern(row.pattern, row.scope, row.flags);
  }
  return counts;
}

function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

const counts = currentCounts();

if (BOOTSTRAP) {
  if (process.env.CI === "true") {
    console.error(
      "Refusing --bootstrap under CI=true. Baselines only shrink after landing, never grow in CI.",
    );
    process.exit(1);
  }
  const baseline = {};
  for (const row of RULES)
    baseline[row.id] = { count: counts[row.id], scope: row.scope ?? row.kind };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline bootstrapped at ${path.relative(ROOT, BASELINE_PATH)}.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(
    `Missing ${path.relative(ROOT, BASELINE_PATH)}. Run: nub run check:static-baseline -- --bootstrap`,
  );
  process.exit(1);
}

const baseline = readBaseline();
let failed = false;
for (const row of RULES) {
  const expected = baseline[row.id]?.count ?? 0;
  const actual = counts[row.id];
  const status = actual <= expected ? "ok" : "FAIL";
  console.log(`  ${row.id}  ${actual} (baseline ${expected})  ${status}`);
  if (actual > expected) {
    failed = true;
    console.log(`FAIL ${row.id} +${actual - expected} (baseline ${expected})`);
    console.log("  Fix the type, or call escape() in src/util/escape.ts and say why.");
  }
}
if (failed) process.exit(1);
console.log("Static baseline check passed.");
