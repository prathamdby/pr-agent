import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROWS_DIR = path.join(SCRIPT_ROOT, "scripts", "guards");
const REPORT = process.argv.includes("--report");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readRows() {
  return fs
    .readdirSync(ROWS_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => JSON.parse(fs.readFileSync(path.join(ROWS_DIR, name), "utf8")));
}

function scopePath(tree, scope) {
  if (scope === "src") return path.join(tree, "src");
  if (scope === "test") return path.join(tree, "test");
  throw new Error(`unknown scope ${scope}`);
}

function countPattern(tree, row) {
  const root = scopePath(tree, row.scope);
  if (!fs.existsSync(root)) return 0;
  const flags = row.flags ? row.flags.split(" ").filter(Boolean) : [];
  let out = "";
  try {
    out = execFileSync(
      "rg",
      ["--no-messages", "-o", "--no-filename", ...flags, "-e", row.pattern, root],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (error && error.status === 1) return 0;
    throw error;
  }
  return out.split("\n").filter((line) => line.length > 0).length;
}

function countFiles(tree, row) {
  const root = scopePath(tree, row.scope);
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(row.suffix)) count += 1;
    }
  };
  walk(root);
  return count;
}

function countOxRule(tree, row) {
  const root = scopePath(tree, row.scope);
  if (!fs.existsSync(root)) return 0;
  const oxlint = path.join(
    SCRIPT_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "oxlint.cmd" : "oxlint",
  );
  const treeConfig = path.join(tree, ".oxlintrc.json");
  const config = fs.existsSync(treeConfig) ? treeConfig : path.join(SCRIPT_ROOT, ".oxlintrc.json");
  let raw = "";
  try {
    raw = execFileSync(oxlint, ["--format", "json", "-c", config, "--deny", row.rule, root], {
      cwd: SCRIPT_ROOT,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    raw = typeof error.stdout === "string" ? error.stdout : "";
    if (!raw.trim().startsWith("{") && !raw.trim().startsWith("[")) {
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(`oxlint failed for ${row.id}: ${stderr || raw || error.message}`);
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : null;
  const diagnostics = parsed
    ? parsed.diagnostics
    : trimmed
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line));
  return diagnostics.filter((item) => item.code === row.lintCode).length;
}

function measure(tree, rows) {
  const counts = {};
  for (const row of rows) {
    if (row.kind === "pattern") counts[row.id] = countPattern(tree, row);
    else if (row.kind === "files") counts[row.id] = countFiles(tree, row);
    else if (row.kind === "oxlint-deny") counts[row.id] = countOxRule(tree, row);
    else throw new Error(`unknown row kind ${row.kind} in ${row.id}`);
  }
  return counts;
}

function archiveTree(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-ledger-"));
  const tar = execFileSync("git", ["archive", "--format=tar", sha], {
    cwd: SCRIPT_ROOT,
    maxBuffer: 100 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(dir, "tree.tar"), tar);
  execFileSync("tar", ["-xf", "tree.tar"], { cwd: dir });
  const modules = path.join(SCRIPT_ROOT, "node_modules");
  const linked = path.join(dir, "node_modules");
  if (fs.existsSync(modules) && !fs.existsSync(linked)) {
    fs.symlinkSync(modules, linked);
  }
  return dir;
}

function mergeBase() {
  const explicit = argValue("--base");
  if (explicit) return explicit;
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
  }).trim();
}

const rows = readRows();
const headTree = path.resolve(argValue("--head-tree") ?? SCRIPT_ROOT);
const baseTreeArg = argValue("--base-tree");
const baseSha = baseTreeArg ? undefined : mergeBase();
const baseTree = baseTreeArg ? path.resolve(baseTreeArg) : archiveTree(baseSha);
const headCounts = measure(headTree, rows);
const baseCounts = measure(baseTree, rows);

let loosening = false;
for (const row of rows) {
  const head = headCounts[row.id];
  const base = baseCounts[row.id];
  const status = head > base ? "LOOSENING" : "ok";
  console.log(`  ${row.id}  head ${head}  base ${base}  ${status}`);
  if (head > base) loosening = true;
}

if (process.env.GITHUB_OUTPUT && REPORT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `loosening=${loosening ? "true" : "false"}\n`);
}

if (loosening && !REPORT) {
  console.error("Guard ledger found a loosening against the merge base.");
  process.exit(1);
}
console.log(loosening ? "Guard ledger loosening recorded." : "Guard ledger passed.");
