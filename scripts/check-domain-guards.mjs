import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (msg) => failures.push(msg);

function rg(pattern, dir, flags = "") {
  try {
    return execSync(
      `rg --no-messages ${flags} -e ${JSON.stringify(pattern)} ${JSON.stringify(path.join(ROOT, dir))} || true`,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    ).trim();
  } catch {
    return "";
  }
}

// 1. console.* only in the src/index.ts boot error path (stock: exactly that one).
const consoleHits = rg("console\\.(log|error|warn|info|debug|trace)\\s*\\(", "src", "--line-number")
  .split("\n")
  .filter(Boolean);
const allowedConsole = ["index.ts:12"];
const strayConsole = consoleHits.filter((line) => !allowedConsole.some((a) => line.includes(a)));
if (strayConsole.length > 0) {
  fail(`console.* outside the src/index.ts boot path:\n${strayConsole.join("\n")}`);
}

// 2. Migration filenames strictly sequential ^\d{3}_, no gaps or duplicates.
const migrationsDir = path.join(ROOT, "migrations");
const numbers = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => {
    const m = f.match(/^(\d{3})_/);
    if (!m) fail(`migration without NNN_ prefix: ${f}`);
    return m ? Number(m[1]) : null;
  })
  .filter((n) => n !== null)
  .toSorted((a, b) => a - b);
const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
if (dupes.length > 0) fail(`duplicate migration numbers: ${[...new Set(dupes)].join(", ")}`);
for (let i = 0; i < numbers.length; i++) {
  if (numbers[i] !== i + 1) {
    fail(
      `migration numbering gap: expected ${String(i + 1).padStart(3, "0")}, have ${numbers.length} files ending at ${String(numbers[numbers.length - 1]).padStart(3, "0")}`,
    );
    break;
  }
}

// 3. escape() call count cross-checked against the static baseline.
const baseline = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "baselines", "static-baseline.json"), "utf8"),
);
const escapeOut = execSync(
  `rg --no-messages -o --no-filename -e ${JSON.stringify("\\bescape\\s*\\(")} ${JSON.stringify(path.join(ROOT, "src"))} || true`,
  { encoding: "utf8" },
);
const escapeCount = escapeOut.split("\n").filter(Boolean).length;
if (escapeCount !== (baseline["escape-calls"]?.count ?? -1)) {
  fail(
    `escape() count ${escapeCount} disagrees with baseline ${baseline["escape-calls"]?.count ?? "missing"}`,
  );
}

// 4. Site parity: every FEATURE_* key in src/settings/envKeys.ts is in
// site/lib/llmsKnowledge.ts FEATURE_KEYS (docs/features.md parity already
// enforced by test/settingsInventory.test.ts).
const envKeys = fs.readFileSync(path.join(ROOT, "src", "settings", "envKeys.ts"), "utf8");
const llms = fs.readFileSync(path.join(ROOT, "site", "lib", "llmsKnowledge.ts"), "utf8");
for (const match of envKeys.matchAll(/"(FEATURE_[A-Z_]+)"/g)) {
  if (!llms.includes(match[1]))
    fail(`site drift: ${match[1]} missing from site/lib/llmsKnowledge.ts`);
}

// 5. AGENTS.md path drift: every backticked path-like token exists.
const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
const tokens = new Set([...agents.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
const pathLike = [...tokens].filter(
  (t) =>
    t.includes("/") &&
    !t.includes(" ") &&
    !t.startsWith("http") &&
    !t.includes("*") &&
    !t.includes("<"),
);
for (const token of pathLike) {
  const candidate = path.join(ROOT, token.replace(/\/$/, ""));
  if (!fs.existsSync(candidate)) fail(`AGENTS.md drift: \`${token}\` does not exist`);
}

if (failures.length > 0) {
  console.error(`Domain guard failures:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Domain guards passed.");
