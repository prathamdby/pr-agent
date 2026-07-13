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

  // Operators must replace these stubs with publication-free legacy/hybrid runners.
  // Empty stubs must never green-light rollout gates.
  const report = await runReplay({
    manifest,
    runLegacy: async () => {
      throw new Error(
        "review-replay: wire a publication-free legacy runner before evaluating gates",
      );
    },
    runHybrid: async () => {
      throw new Error(
        "review-replay: wire a publication-free hybrid runner before evaluating gates",
      );
    },
  });

  console.log(JSON.stringify(report, null, 2));
  console.error(report.gate.details);
  process.exit(report.gate.overallPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
