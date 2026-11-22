import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this verifier through npm run verify.");
  process.exit(1);
}

const useEnv = process.argv.includes("--use-env");
const envDir = process.env.SQLITE_DIR;
const envDirInUse =
  envDir !== undefined &&
  envDir.length > 0 &&
  fs.existsSync(envDir) &&
  fs.readdirSync(envDir).length > 0;

if (envDirInUse && !useEnv) {
  console.error(
    `Refusing: SQLITE_DIR (${envDir}) is a non-empty directory. Pass --use-env to run against it, or unset it for a disposable directory.`,
  );
  process.exit(1);
}

const disposable = !(useEnv && envDir);
const sqliteDir = disposable ? fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-verify-")) : envDir;

async function importSource(rel) {
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

async function readPragmas() {
  const { openAppState } = await importSource("src/state/db.ts");
  const { applyAppStateSchema } = await importSource("src/state/schema.ts");
  const appState = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
  let app;
  try {
    app = {
      path: appState.path,
      synchronous: appState.db.prepare("PRAGMA synchronous").get()?.synchronous,
      journalMode: appState.db.prepare("PRAGMA journal_mode").get()?.journal_mode,
      userVersion: appState.db.prepare("PRAGMA user_version").get()?.user_version,
    };
  } finally {
    appState.close();
  }

  const { openDurableHarness, PI_DURABLE_DB_FILENAME } = await importSource(
    "src/agent/runtime/durable/harness.ts",
  );
  const { createRegistry } = await importSource("src/agent/runtime/durable/providerRouting.ts");
  await openDurableHarness({
    sqliteDir,
    registry: createRegistry(),
    models: () => [],
  });
  const pi = {
    path: path.join(sqliteDir, PI_DURABLE_DB_FILENAME),
    synchronous: 2,
    note: "openDurableHarness sets PRAGMA synchronous = FULL and refuses to open unless it reads back 2",
  };
  return { app, pi };
}

const started = new Date().toISOString();
let result = "";
let pragmas;
let pragmaError = "";
let failed = false;
try {
  try {
    result = execFileSync(process.execPath, [npmCli, "run", "test:integration"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, SQLITE_DIR: sqliteDir },
    });
    console.log(result.slice(-2000));
  } catch (error) {
    failed = true;
    result = error.stdout ?? String(error);
    console.log(result.slice(-2000));
  }
  try {
    pragmas = await readPragmas();
    if (pragmas.app.synchronous !== 2) {
      failed = true;
      pragmaError = `app_state.sqlite synchronous read back ${String(pragmas.app.synchronous)}, expected 2`;
    }
  } catch (error) {
    failed = true;
    pragmaError = error instanceof Error ? error.message : String(error);
  }
} finally {
  const stamp = started.replace(/[:.]/g, "-");
  const dir = path.join(ROOT, "verify-artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, `${stamp}.md`);
  const pragmaLines = pragmas
    ? [
        `- app_state.sqlite (${pragmas.app.path}): synchronous=${String(pragmas.app.synchronous)}, journal_mode=${String(pragmas.app.journalMode)}, user_version=${String(pragmas.app.userVersion)}`,
        `- pi_durable.sqlite (${pragmas.pi.path}): synchronous=${String(pragmas.pi.synchronous)} (${pragmas.pi.note})`,
      ]
    : [];
  if (pragmaError) pragmaLines.push(`- PRAGMA check failed: ${pragmaError}`);
  fs.writeFileSync(
    artifact,
    [
      `# Verify ${started}`,
      "",
      `Result: ${failed ? "FAIL" : "PASS"}`,
      "",
      `SQLITE_DIR: ${sqliteDir} (${disposable ? "disposable temp directory" : "provided via --use-env"})`,
      "",
      "## PRAGMA read-backs",
      "",
      ...pragmaLines,
      "",
      "## npm run test:integration (tail)",
      "",
      "```",
      result.slice(-8000),
      "```",
      "",
    ].join("\n"),
  );
  console.log(`Artifact: ${path.relative(ROOT, artifact)}`);
  if (disposable) fs.rmSync(sqliteDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
