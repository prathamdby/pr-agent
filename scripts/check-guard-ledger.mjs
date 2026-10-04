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

function assertRealScope(root) {
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`refusing to measure symlink scope ${root}`);
  }
}

function countPattern(tree, row) {
  const root = scopePath(tree, row.scope);
  if (!fs.existsSync(root)) return 0;
  assertRealScope(root);
  const flags = row.flags ? row.flags.split(" ").filter(Boolean) : [];
  let out = "";
  try {
    out = execFileSync(
      "rg",
      [
        "--no-messages",
        "--no-ignore",
        "--no-config",
        "-o",
        "--no-filename",
        ...flags,
        "-e",
        row.pattern,
        root,
      ],
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
  assertRealScope(root);
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
  // Globs in the config are relative to the tree. The bytes always come from the
  // script checkout, so a head .oxlintrc.json cannot turn a counted rule off.
  const trusted = path.join(SCRIPT_ROOT, ".oxlintrc.json");
  const local = path.join(tree, ".oxlintrc.json");
  const measuringOtherTree = path.resolve(tree) !== path.resolve(SCRIPT_ROOT);
  let restore = null;
  if (measuringOtherTree) {
    if (fs.existsSync(local) && fs.lstatSync(local).isSymbolicLink()) {
      throw new Error(`refusing symlink oxlint config in ${tree}`);
    }
    const previous = fs.existsSync(local) ? fs.readFileSync(local) : null;
    fs.copyFileSync(trusted, local);
    restore = () => {
      if (previous) fs.writeFileSync(local, previous);
      else fs.rmSync(local, { force: true });
    };
  }
  const config = measuringOtherTree ? local : trusted;
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
      throw new Error(`oxlint failed for ${row.id}: ${stderr || raw || error.message}`, {
        cause: error,
      });
    }
  } finally {
    restore?.();
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

function gitOk(args) {
  try {
    execFileSync("git", args, { cwd: SCRIPT_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// CI checks out the pull request at depth 1, so origin/main and the commits
// between it and HEAD are absent until this fetch.
function ensureMergeBase() {
  if (!gitOk(["rev-parse", "--verify", "--quiet", "origin/main"])) {
    execFileSync("git", ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"], {
      cwd: SCRIPT_ROOT,
      stdio: "inherit",
    });
  }
  if (gitOk(["merge-base", "HEAD", "origin/main"])) return;
  execFileSync("git", ["fetch", "--no-tags", "--unshallow", "origin"], {
    cwd: SCRIPT_ROOT,
    stdio: "inherit",
  });
}

function mergeBase() {
  const explicit = argValue("--base");
  if (explicit) return explicit;
  ensureMergeBase();
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
  }).trim();
}

const rows = readRows();
const headTree = path.resolve(argValue("--head-tree") ?? SCRIPT_ROOT);
const baseTreeArg = argValue("--base-tree");
const baseSha = baseTreeArg ? undefined : mergeBase();
const archivedBase = baseTreeArg == null;
const baseTree = archivedBase ? archiveTree(baseSha) : path.resolve(baseTreeArg);
let headCounts;
let baseCounts;
try {
  headCounts = measure(headTree, rows);
  baseCounts = measure(baseTree, rows);
} finally {
  if (archivedBase) fs.rmSync(baseTree, { recursive: true, force: true });
}

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
