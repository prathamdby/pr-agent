/**
 * Optional offline prompt-cost comparison report.
 * Prints JSON to stdout. Not required CI — vitest is the gate.
 *
 * Usage (from repo root, after nub install):
 *   node scripts/prompt-cost-eval-report.mjs
 *
 * Deterministic CI gate:
 *   nub run test -- test/promptCostCompressionEval.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(tmpdir(), `prompt-cost-eval-report-${process.pid}.json`);

const result = spawnSync(
  "nub",
  [
    "run",
    "test",
    "--",
    "test/promptCostCompressionEval.test.ts",
    "-t",
    "emits a machine-readable comparison report shape",
    "--reporter=dot",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PROMPT_COST_EVAL_OUT: outPath,
    },
    maxBuffer: 20 * 1024 * 1024,
  },
);

if (result.status !== 0) {
  process.stderr.write(
    (result.stderr || result.stdout || "prompt-cost-eval-report failed").slice(0, 2500) +
      "\nHint: run `nub run test -- test/promptCostCompressionEval.test.ts` for the CI harness.\n",
  );
  process.exit(result.status ?? 1);
}

try {
  const json = readFileSync(outPath, "utf8");
  process.stdout.write(json.endsWith("\n") ? json : `${json}\n`);
} catch (error) {
  process.stderr.write(
    `Failed to read report at ${outPath}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
} finally {
  try {
    unlinkSync(outPath);
  } catch {
    // ignore
  }
}
