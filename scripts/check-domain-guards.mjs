import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (msg) => failures.push(msg);

// 1. Migration filenames strictly sequential ^\d{3}_, no gaps or duplicates.
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

// 2. Site parity: every FEATURE_* key in src/settings/envKeys.ts is in
// site/lib/llmsKnowledge.ts FEATURE_KEYS (docs/features.md parity already
// enforced by test/settingsInventory.test.ts).
const envKeys = fs.readFileSync(path.join(ROOT, "src", "settings", "envKeys.ts"), "utf8");
const llms = fs.readFileSync(path.join(ROOT, "site", "lib", "llmsKnowledge.ts"), "utf8");
for (const match of envKeys.matchAll(/"(FEATURE_[A-Z_]+)"/g)) {
  if (!llms.includes(match[1]))
    fail(`site drift: ${match[1]} missing from site/lib/llmsKnowledge.ts`);
}

if (failures.length > 0) {
  console.error(`Domain guard failures:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Domain guards passed.");
