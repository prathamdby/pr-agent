#!/usr/bin/env node

import { performance } from "node:perf_hooks";

const scenarios = [
  {
    name: "slash-review-medium-pr",
    steps: [
      ["webhook_ack", 2, "internal"],
      ["enqueue_to_pickup", 1, "internal"],
      ["db_read", 1, "internal"],
      ["workspace", 4, "internal"],
      ["prior_feedback", 25, "github"],
      ["send_1", 120, "llm"],
      ["send_2", 120, "llm"],
      ["publish", 30, "github"],
    ],
  },
  {
    name: "auto-review-docs-only-pr",
    steps: [
      ["webhook_ack", 2, "internal"],
      ["enqueue_to_pickup", 1, "internal"],
      ["db_read", 1, "internal"],
      ["preflight", 25, "github"],
      ["lightweight_publish", 30, "github"],
    ],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timeStep([phase, fixedMs, bucket]) {
  const started = performance.now();
  await sleep(fixedMs);
  return { phase, bucket, elapsedMs: performance.now() - started, fixedStubMs: fixedMs };
}

for (const scenario of scenarios) {
  const steps = [];
  for (const step of scenario.steps) {
    steps.push(await timeStep(step));
  }
  const totals = steps.reduce(
    (acc, step) => {
      acc.totalMs += step.elapsedMs;
      acc[`${step.bucket}Ms`] += step.elapsedMs;
      return acc;
    },
    { totalMs: 0, internalMs: 0, githubMs: 0, llmMs: 0 },
  );
  console.log(JSON.stringify({ scenario: scenario.name, totals, steps }, null, 2));
}
