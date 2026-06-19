import { execFileSync } from "node:child_process";

const forbiddenEvlogPeers = new Set(["express", "hono", "next", "react", "vite"]);

const nubCmd = process.platform === "win32" ? "nub.cmd" : "nub";
const output = execFileSync(
  nubCmd,
  ["list", "--prod", "--filter", "pr-agent", "--depth", "Infinity", "--json"],
  { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
);

const projects = JSON.parse(output);
const hits = new Set();

function visit(name, node, path) {
  const nextPath = [...path, `${name}@${node.version ?? "unknown"}`];
  const isEvlogBranch = nextPath.some((part) => part.startsWith("evlog@"));
  if (isEvlogBranch && forbiddenEvlogPeers.has(name)) {
    hits.add(nextPath.join(" > "));
  }

  const dependencies = node.dependencies ?? {};
  for (const [dependencyName, dependencyNode] of Object.entries(dependencies)) {
    visit(dependencyName, dependencyNode, nextPath);
  }
}

for (const project of projects) {
  const dependencies = project.dependencies ?? {};
  for (const [name, node] of Object.entries(dependencies)) {
    visit(name, node, [project.name ?? "root"]);
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
