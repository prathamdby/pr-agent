import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const npm = args.find((arg) => !arg.startsWith("--")) ?? "npm";
const full = args.includes("--all");
const manifestPath = "package.json";
const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
manifest.devEngines.runtime.version = ">=24.0.0 <27";
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

try {
  const ciArgs = ["ci"];
  if (!full) {
    ciArgs.push("--workspace=pr-agent-landing", "--include-workspace-root=false");
  }
  const result = spawnSync(npm, ciArgs, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  writeFileSync(manifestPath, original);
}
