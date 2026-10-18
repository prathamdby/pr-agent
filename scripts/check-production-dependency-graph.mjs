import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check through npm run check:prod-deps.");
const site = JSON.parse(readFileSync(path.join(root, "site/package.json"), "utf8"));
const frontendOnly = new Set([site.name, ...Object.keys(site.dependencies)]);
const forbiddenEvlogPeers = new Set(["express", "hono", "next", "react", "vite"]);
const installation = mkdtempSync(path.join(homedir(), ".pr-agent-production-"));
try {
  mkdirSync(path.join(installation, "site"));
  for (const file of ["package.json", "package-lock.json", ".npmrc", "site/package.json"]) {
    copyFileSync(path.join(root, file), path.join(installation, file));
  }
  execFileSync(
    process.execPath,
    [npmCli, "ci", "--omit=dev", "--workspaces=false", "--no-audit", "--no-fund"],
    {
      cwd: installation,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  const query = (selector) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [npmCli, "query", selector, "--workspaces=false", "--legacy-peer-deps=false"],
        {
          cwd: installation,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
        },
      ),
    );
  const hits = new Set();
  if (existsSync(path.join(installation, "node_modules", site.name))) hits.add(site.name);
  for (const node of query("*")) {
    if (node.location.includes("node_modules/") && frontendOnly.has(node.name))
      hits.add(`${node.name}@${node.version} (${node.location})`);
  }
  for (const node of query('[name="evlog"] *')) {
    if (forbiddenEvlogPeers.has(node.name))
      hits.add(`evlog > ${node.name}@${node.version} (${node.location})`);
  }
  if (hits.size > 0) {
    console.error(
      [
        "Production dependency graph includes frontend-only packages or evlog framework adapter peers:",
        ...[...hits].toSorted((a, b) => a.localeCompare(b)).map((hit) => `- ${hit}`),
      ].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log("Installed backend production dependency graph check passed.");
  }
} finally {
  rmSync(installation, { recursive: true, force: true });
}
