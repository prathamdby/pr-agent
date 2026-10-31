import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const jarUrl = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const jarSha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const jarPath = join(tmpdir(), "tla2tools-1.7.4.jar");
const spec = join(here, "PrActorLease.tla");

const runs = [
  {
    name: "safety",
    config: "safety.cfg",
    expectViolation: null,
  },
  {
    name: "exactly-once",
    config: "exactly-once.cfg",
    expectViolation: null,
  },
  {
    name: "supersede",
    config: "supersede.cfg",
    expectViolation: null,
  },
  {
    name: "broken-fence",
    config: "broken-fence.cfg",
    expectViolation: "NoStaleDurable",
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readRepo(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function sliceExport(source, startText) {
  const start = source.indexOf(startText);
  if (start < 0) return null;
  const next = source.slice(start + startText.length).search(/\nexport /);
  if (next < 0) return source.slice(start);
  return source.slice(start, start + startText.length + next);
}

function requireIncludes(label, text, snippet) {
  if (text == null || !text.includes(snippet)) {
    fail(`${label} no longer contains the text the model treats as one step:\n${snippet}`);
  }
}

function requireExcludes(label, text, snippet) {
  if (text == null || text.includes(snippet)) {
    fail(
      `${label} now contains ${JSON.stringify(snippet)}. The model is stale until that change is transcribed.`,
    );
  }
}

function requireSamePredicate(labelA, textA, labelB, textB, snippet) {
  const hasA = textA != null && textA.includes(snippet);
  const hasB = textB != null && textB.includes(snippet);
  if (hasA !== hasB) {
    fail(
      `${labelA} and ${labelB} must both contain ${JSON.stringify(snippet)}, or neither. Only one does.`,
    );
  }
  if (!hasA) {
    fail(`${labelA} and ${labelB} are missing ${JSON.stringify(snippet)}.`);
  }
}

function requireOrder(label, text, snippets) {
  if (text == null) fail(`${label} is missing.`);
  let from = 0;
  for (const snippet of snippets) {
    const at = text.indexOf(snippet, from);
    if (at < 0) {
      fail(`${label} lost the order the model uses. Missing:\n${snippet}`);
    }
    from = at + snippet.length;
  }
}

function checkAnchors() {
  const lease = readRepo("src/agentWork/prActorLease.ts");
  const acquire = sliceExport(lease, "export async function acquirePrActorLease");
  requireIncludes("acquirePrActorLease", acquire, "lease_epoch  = l.lease_epoch + 1");
  requireIncludes(
    "acquirePrActorLease",
    acquire,
    "WHERE l.work_item_id IS NULL OR l.expires_at <= now()",
  );

  const renew = sliceExport(lease, "export async function renewPrActorLease");
  requireIncludes("renewPrActorLease", renew, "AND lease_epoch = $3");
  requireIncludes("renewPrActorLease", renew, "AND work_item_id = $5");
  const renewWhere = renew?.slice(renew.indexOf("WHERE resource_key"));
  requireExcludes("renewPrActorLease WHERE", renewWhere, "expires_at");

  const clear = sliceExport(lease, "export async function releasePrActorLeaseHeldByWorkItems");
  requireIncludes("releasePrActorLeaseHeldByWorkItems", clear, "SET work_item_id = NULL");
  requireIncludes("releasePrActorLeaseHeldByWorkItems", clear, "AND p.epoch = l.lease_epoch");
  requireExcludes("releasePrActorLeaseHeldByWorkItems", clear, "lease_epoch + 1");

  const held = sliceExport(lease, "export async function isPrActorLeaseHeld");
  requireIncludes("isPrActorLeaseHeld", held, "AND lease_epoch = $2");
  requireIncludes("isPrActorLeaseHeld", held, "expires_at > now()");

  const execution = readRepo("src/agentWork/leasedExecution.ts");
  const boundary = sliceExport(execution, "function createLeaseMutationBoundary");
  requireOrder("createLeaseMutationBoundary", boundary, [
    "await assertPrActorLeaseHeld(params.pool, params.workItemId, params.leaseEpoch);",
    "mutationStarted = true;",
    "return mutate();",
  ]);
  const renewal = sliceExport(execution, "export function startLeaseRenewal");
  const errorCallback = renewal?.slice(renewal.indexOf("(error: unknown)"));
  requireIncludes("startLeaseRenewal", renewal, "onLost();");
  requireExcludes("startLeaseRenewal error callback", errorCallback, "onLost");

  const claim = sliceExport(execution, "export async function acquireAndClaimWorkItem");
  requireOrder("acquireAndClaimWorkItem", claim, [
    "await acquirePrActorLease(client,",
    "await claimWorkForExecution(client, params.core.id, acquisition.leaseEpoch)",
  ]);

  const surface = readRepo("src/github/prSurfaceMutation.ts");
  const run = surface.slice(surface.indexOf("const run = ("));
  requireOrder("withPrSurfaceMutationBoundary", run, [
    "throwIfAborted(boundary.signal);",
    "await boundary.confirmLeaseHeld();",
    "return mutate();",
  ]);

  const publish = readRepo("src/agentWork/publishOnce.ts");
  const body = sliceExport(publish, "async function publishOnceBody");
  requireOrder("publishOnceBody", body, [
    "findInFlightMutatingIntent(",
    "return recoverAfterMutatingWithoutResult(params, inFlight);",
    "[OPERATION_INTENT_MUTATING_KEY]: true,",
    "const result = await params.mutate();",
  ]);
  const intents = readRepo("src/agentWork/operationIntentRepository.ts");
  const persist = sliceExport(intents, "export async function persistOperationIntent");
  const merge = sliceExport(intents, "export async function mergeOperationIntentDetail");
  requireIncludes("persistOperationIntent", persist, "expires_at > now()");
  requireIncludes("mergeOperationIntentDetail", merge, "expires_at > now()");
  const reconcile = sliceExport(intents, "export async function reconcileOperationIntent");
  const record = sliceExport(publish, "async function recordPublishStep");
  requireSamePredicate(
    "reconcileOperationIntent",
    reconcile,
    "recordPublishStep",
    record,
    "expires_at > now()",
  );
  const lookup = sliceExport(intents, "export async function findInFlightMutatingIntent");
  const batch = sliceExport(publish, "export function deterministicInlineBatchId");
  const batchUsesWorkItem = batch != null && batch.includes("params.workItemId");
  const crossItem = lookup != null && lookup.includes("i.work_item_id <> $1");
  const requiresSameKey = lookup != null && lookup.includes("operation_key =") && !crossItem;
  if (batchUsesWorkItem && requiresSameKey) {
    fail(
      "deterministicInlineBatchId includes workItemId and the in-flight lookup requires the same operation_key.",
    );
  }
  if (!batchUsesWorkItem) {
    fail("deterministicInlineBatchId no longer includes the work item id.");
  }
  if (!crossItem) {
    fail(
      "findInFlightMutatingIntent does not recover another work item without operation_key equality.",
    );
  }

  const migration = readRepo("migrations/016_agent_runtime_durability.sql");
  requireIncludes("operation_intents", migration, "UNIQUE (work_item_id, operation_key)");

  const summary = readRepo("src/review/publish/publishSummaryOnly.ts");
  requireOrder("publishSummaryOnly", summary, [
    "operationIntentMarker(",
    "coordination.workItemId,",
  ]);
  const reviewPublish = readRepo("src/github/reviewPublish.ts");
  requireExcludes("src/github/reviewPublish.ts", reviewPublish, "signal");
  requireIncludes(
    "REVIEW_SUMMARY_SENTINEL",
    readRepo("src/settings/reviewConstants.ts"),
    'export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review"',
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureJar() {
  if (!existsSync(jarPath) || sha256(jarPath) !== jarSha256) {
    const download = spawnSync("curl", ["-fsSL", "-o", jarPath, "-L", jarUrl], {
      encoding: "utf8",
    });
    if (download.status !== 0) {
      fail(`Could not download TLC from ${jarUrl}\n${download.stderr}`);
    }
    const got = sha256(jarPath);
    if (got !== jarSha256) {
      fail(`TLC jar hash is ${got}, expected ${jarSha256}`);
    }
  }
}

function runTlc(run) {
  const metadir = join(tmpdir(), `pr-actor-lease-${run.name}`);
  mkdirSync(metadir, { recursive: true });
  const result = spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-Xmx2g",
      "-jar",
      jarPath,
      "-workers",
      "1",
      "-difftrace",
      "-config",
      join(here, run.config),
      "-metadir",
      metadir,
      spec,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(metadir, "tlc.txt"), output);
  return { status: result.status, output, metadir };
}

function violationName(output) {
  const match = output.match(/Invariant (\w+) is violated/);
  return match?.[1] ?? null;
}

checkAnchors();
ensureJar();

for (const run of runs) {
  const { status, output, metadir } = runTlc(run);
  const violated = violationName(output);
  if (run.expectViolation == null) {
    if (status !== 0 || !output.includes("No error has been found.")) {
      console.error(output);
      fail(`safety model failed. Full output: ${join(metadir, "tlc.txt")}`);
    }
    const states = output.match(/(\d+) distinct states found/)?.[1] ?? "unknown";
    console.log(
      `${run.name} passed. TLC found ${states} distinct states. ${join(metadir, "tlc.txt")}`,
    );
    continue;
  }
  if (violated !== run.expectViolation) {
    console.error(output);
    if (violated == null && status === 0) {
      fail(
        `${run.name} passed ${run.expectViolation}. The recorded finding is gone. Update the model and the skill after you confirm the code changed. Do not delete the invariant to keep this command green.`,
      );
    }
    fail(
      `${run.name} violated ${violated ?? "nothing"}, expected ${run.expectViolation}. Full output: ${join(metadir, "tlc.txt")}`,
    );
  }
  console.log(
    `${run.name} violated ${run.expectViolation}, as this checkout does. ${join(metadir, "tlc.txt")}`,
  );
}

console.log("Anchors match, and the TLC results match this checkout.");
