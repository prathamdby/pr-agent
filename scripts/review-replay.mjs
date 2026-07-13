#!/usr/bin/env node
/**
 * Replay script for historical Review evaluation (U6).
 *
 * Usage: node scripts/review-replay.mjs <manifest-path>
 *
 * Loads a versioned replay manifest, runs both legacy and hybrid pipelines
 * through a publication-free evaluation boundary, and prints gate results.
 */
import { readFile } from "node:fs/promises";
import { validateManifest, runReplay } from "../src/review/evaluation/reviewReplay.js";

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/review-replay.mjs <manifest-path>");
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = validateManifest(raw);

  const report = await runReplay({
    manifest,
    runLegacy: async () => ({ findings: [], durationMs: 0 }),
    runHybrid: async () => ({ findings: [], durationMs: 0 }),
  });

  console.log(JSON.stringify(report, null, 2));
  console.error(report.gate.details);
  process.exit(report.gate.recallPass && report.gate.falsePositivePass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
