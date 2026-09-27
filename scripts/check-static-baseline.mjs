import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "baselines", "static-baseline.json");

// Fail-on-growth rules. Counts come from oxlint JSON for lint rules and from
// regex scans for source rules oxlint cannot see. Adding a rule here requires
// a baseline entry; growing a count fails the gate.
const RULES = [
  {
    id: "no-unsafe-type-assertion",
    kind: "oxlint",
    code: "typescript(no-unsafe-type-assertion)",
    scope: "src/**",
    fix: "Fix the type. Do not add a cast to merge.",
  },
  {
    id: "no-console",
    kind: "grep",
    scope: "src/**",
    pattern: /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/g,
    fix: "Remove console.* outside the src/index.ts boot error path; use evlog.",
  },
  {
    id: "escape-calls",
    kind: "grep",
    scope: "src/**",
    pattern: /\bescape\s*\(/g,
    exclude: ["src/util/escape.ts"],
    fix: "Do not add escape() calls to merge.",
  },
];

function listTsFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function countOxlint(rule) {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npxCmd, ["oxlint", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    const stderr = (result.stderr ?? "").trim().slice(0, 2000);
    console.error(`static-baseline: oxlint produced no JSON output.${stderr ? `\n${stderr}` : ""}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    console.error("static-baseline: could not parse oxlint JSON output.");
    process.exit(1);
  }
  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : null;
  if (!diagnostics) {
    console.error("static-baseline: unexpected oxlint JSON shape (missing diagnostics array).");
    process.exit(1);
  }
  const perFile = new Map();
  for (const diag of diagnostics) {
    if (diag?.code !== rule.code) continue;
    const filename = typeof diag?.filename === "string" ? diag.filename : "";
    // Scopes are repo-relative prefixes: "src/**" matches "src/...".
    if (rule.scope === "src/**" && !filename.startsWith("src/")) continue;
    perFile.set(filename, (perFile.get(filename) ?? 0) + 1);
  }
  let total = 0;
  for (const count of perFile.values()) total += count;
  return { total, perFile };
}

function countGrep(rule) {
  const srcDir = path.join(ROOT, "src");
  const excluded = new Set(rule.exclude ?? []);
  const perFile = new Map();
  let total = 0;
  for (const full of listTsFiles(srcDir)) {
    const relative = path.relative(ROOT, full);
    if (excluded.has(relative)) continue;
    const content = fs.readFileSync(full, "utf8");
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    const matches = content.match(pattern);
    if (matches) {
      perFile.set(relative, matches.length);
      total += matches.length;
    }
  }
  return { total, perFile };
}

function countRule(rule) {
  if (rule.kind === "oxlint") return countOxlint(rule);
  return countGrep(rule);
}

function loadBaseline() {
  let raw;
  try {
    raw = fs.readFileSync(BASELINE_PATH, "utf8");
  } catch {
    console.error(
      `static-baseline: missing ${path.relative(ROOT, BASELINE_PATH)}. Run 'nub run check:static-baseline --bootstrap' locally (never in CI) to create it.`,
    );
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`static-baseline: invalid JSON in ${path.relative(ROOT, BASELINE_PATH)}.`);
    process.exit(1);
  }
  for (const rule of RULES) {
    const entry = data[rule.id];
    if (!entry || typeof entry.count !== "number" || typeof entry.scope !== "string") {
      console.error(
        `static-baseline: baseline entry '${rule.id}' is missing or invalid. Run 'nub run check:static-baseline --bootstrap' locally to regenerate it.`,
      );
      process.exit(1);
    }
  }
  return data;
}

const args = new Set(process.argv.slice(2));
const bootstrap = args.has("--bootstrap");

if (bootstrap) {
  if (process.env.CI === "true" || process.env.CI === "1") {
    console.error(
      "static-baseline: refusing --bootstrap when CI is set. Bootstrap locally, then land the updated baseline in a PR.",
    );
    process.exit(1);
  }
  const next = {};
  for (const rule of RULES) {
    const { total } = countRule(rule);
    next[rule.id] = { count: total, scope: rule.scope };
  }
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  for (const rule of RULES) {
    console.log(
      `${rule.id}  ${rule.scope}  ${next[rule.id].count}  (baseline ${next[rule.id].count})  bootstrapped`,
    );
  }
  process.exit(0);
}

const baseline = loadBaseline();
let failed = false;
const failures = [];
for (const rule of RULES) {
  const { total, perFile } = countRule(rule);
  const expected = baseline[rule.id].count;
  const status = total > expected ? "FAIL" : "ok";
  console.log(`${rule.id}  ${rule.scope}  ${total}  (baseline ${expected})  ${status}`);
  if (total > expected) {
    failed = true;
    failures.push({ rule, total, expected, perFile });
  }
}

for (const { rule, total, expected, perFile } of failures) {
  const ranked = [...perFile.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [file, count] of ranked) {
    console.log(`FAIL ${file}  ${rule.id}  ${count} (total ${total}, baseline ${expected})`);
  }
  console.log(`  ${rule.fix}`);
}

process.exit(failed ? 1 : 0);
