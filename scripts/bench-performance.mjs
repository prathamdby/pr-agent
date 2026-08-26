#!/usr/bin/env node
/**
 * Reproducible performance microbenchmarks for pr-agent.
 * Usage: node scripts/bench-performance.mjs
 * Optional: DATABASE_URL=postgres://... for migration no-op timing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 5);
const ROOT = process.cwd();

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarize(samples) {
  const sorted = [...samples].toSorted((a, b) => a - b);
  return {
    mean: mean(sorted),
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples: sorted,
  };
}

function timeDepImport(specifier) {
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const t0 = performance.now(); await import(${JSON.stringify(specifier)}); console.log(String(performance.now() - t0));`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`import ${specifier} failed: ${r.stderr}`);
    times.push(Number(r.stdout.trim().split("\n").pop()));
  }
  return summarize(times);
}

function runNubScript(label, body) {
  // Keep scripts under the repo so package resolution finds workspace deps.
  const dir = join(ROOT, ".tmp-bench");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, `pr-agent-bench-${label}-${process.pid}.mts`);
  writeFileSync(script, body);
  const r = spawnSync("nub", [script], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  rmSync(script, { force: true });
  if (r.status !== 0) throw new Error(`nub ${label} failed: ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split("\n").findLast(Boolean);
  return JSON.parse(line);
}

function timeNubImport(relPath) {
  const abs = join(ROOT, relPath);
  const times = [];
  const rss = [];
  for (let i = 0; i < SAMPLES; i++) {
    const parsed = runNubScript(
      relPath.replace(/\W+/g, "_"),
      `const t0 = performance.now();
await import(${JSON.stringify(abs)});
console.log(JSON.stringify({ ms: performance.now() - t0, rssMb: process.memoryUsage().rss / 1024 / 1024 }));
`,
    );
    times.push(parsed.ms);
    rss.push(parsed.rssMb);
  }
  return { ms: summarize(times), rssMb: summarize(rss) };
}

function runtimeImportGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const stripped = text
      .replace(/^import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^import\s+type\s+[^;]+;?\s*$/gm, "");
    for (const match of stripped.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      let spec = match[1];
      if (spec.endsWith(".js")) spec = `${spec.slice(0, -3)}.ts`;
      else if (!spec.endsWith(".ts")) spec = `${spec}.ts`;
      const next = resolve(dirname(file), spec).replace(`${ROOT}/`, "");
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen.size;
}

function benchSymbolIndex() {
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const parsed = runNubScript(
      "symbol-index",
      `import { buildSymbolIndex } from ${JSON.stringify(join(ROOT, "src/prWorkspace/symbolIndex.ts"))};
const paths = Array.from({ length: 1000 }, (_, i) => \`src/f\${i}.ts\`);
const content = "export function hello() { return 1; }\\n";
const readFile = async () => content;
await buildSymbolIndex(paths.slice(0, 10), readFile, { readConcurrency: 16 });
const t0 = performance.now();
const index = await buildSymbolIndex(paths, readFile, { readConcurrency: 16 });
if (index.symbolCount !== 1000) throw new Error("unexpected symbolCount " + index.symbolCount);
console.log(JSON.stringify({ ms: performance.now() - t0 }));
`,
    );
    times.push(parsed.ms);
  }
  return summarize(times);
}

function benchMigrations() {
  if (!process.env.DATABASE_URL) return { skipped: true, reason: "DATABASE_URL unset" };
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const parsed = runNubScript(
      "migrations",
      `import { Pool } from "pg";
import { runMigrations } from ${JSON.stringify(join(ROOT, "src/db/migrations.ts"))};
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  if (${i} === 0) await runMigrations(pool);
  const t0 = performance.now();
  await runMigrations(pool);
  console.log(JSON.stringify({ ms: performance.now() - t0 }));
} finally {
  await pool.end();
}
`,
    );
    times.push(parsed.ms);
  }
  return summarize(times);
}

const out = {
  env: {
    node: process.version,
    samples: SAMPLES,
    cwd: ROOT,
  },
  staticImportGraphModules: {
    "src/effect/server.ts": runtimeImportGraph("src/effect/server.ts"),
    "src/worker.ts": runtimeImportGraph("src/worker.ts"),
    "src/agentWork/runtime.ts": runtimeImportGraph("src/agentWork/runtime.ts"),
    "src/agentWork/workerRuntime.ts": runtimeImportGraph("src/agentWork/workerRuntime.ts"),
  },
  dependencyImportMs: {
    effect: timeDepImport("effect"),
    "@effect/platform-node": timeDepImport("@effect/platform-node"),
    "@earendil-works/pi-coding-agent": timeDepImport("@earendil-works/pi-coding-agent"),
  },
  nubModuleImport: {
    "src/effect/server.ts": timeNubImport("src/effect/server.ts"),
    "src/worker.ts": timeNubImport("src/worker.ts"),
    "src/config.ts": timeNubImport("src/config.ts"),
  },
  symbolIndex1000FilesMs: benchSymbolIndex(),
  migrationNoOpMs: benchMigrations(),
};

mkdirSync("/tmp/perf-bench", { recursive: true });
const outPath = `/tmp/perf-bench/optimized-${Date.now()}.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.error(`wrote ${outPath}`);
