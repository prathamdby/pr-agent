import { readFileSync } from "node:fs";
import YAML from "yaml";

const forbiddenEvlogPeers = new Set(["express", "hono", "next", "react", "vite"]);

const lockfile = YAML.parse(readFileSync("pnpm-lock.yaml", "utf8"));
const snapshots = lockfile.snapshots ?? {};
const hits = new Set();

for (const [snapshotKey, snapshot] of Object.entries(snapshots)) {
  if (!snapshotKey.startsWith("evlog@")) continue;
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
      if (forbiddenEvlogPeers.has(name)) hits.add(`${snapshotKey} > ${name}@${version}`);
    }
  }
}

if (hits.size > 0) {
  console.error(
    [
      "Production dependency graph includes evlog framework adapter peers:",
      ...[...hits].toSorted((a, b) => a.localeCompare(b)).map((hit) => `- ${hit}`),
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Production dependency graph check passed.");
