import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "migrations");

const slug = process.argv[2];
if (!slug || !/^[a-z][a-z0-9_]*$/.test(slug)) {
  console.error(
    "Usage: nub run gen:migration <snake_slug>  (lowercase letters, digits, underscores)",
  );
  process.exit(1);
}

const numbers = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.match(/^(\d{3})_/)?.[1])
  .filter(Boolean)
  .map(Number)
  .toSorted((a, b) => a - b);
for (let i = 0; i < numbers.length; i++) {
  if (numbers[i] !== i + 1) {
    console.error(
      `Migration numbering has a gap at ${String(i + 1).padStart(3, "0")}; fix it before minting.`,
    );
    process.exit(1);
  }
}
const next = String(numbers[numbers.length - 1] + 1).padStart(3, "0");
const out = path.join(dir, `${next}_${slug}.sql`);
if (fs.existsSync(out)) {
  console.error(`Collision: ${path.relative(ROOT, out)} already exists.`);
  process.exit(1);
}
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith(`_${slug}.sql`)) {
    console.error(`Duplicate slug: ${f} already uses it.`);
    process.exit(1);
  }
}
fs.writeFileSync(out, `-- ${next}_${slug}\n`);
console.log(`Wrote ${path.relative(ROOT, out)} (bare SQL).`);
