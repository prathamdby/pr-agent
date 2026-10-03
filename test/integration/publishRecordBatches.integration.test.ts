import { createDurableRuntime } from "../../src/agentWork/durableJob.js";
import { createWorkDefinitions } from "../../src/agentWork/workDefinition.js";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.js";
import type { PrSurfaceMutation } from "../../src/github/prSurface.js";
import {
  createPublishContext,
  publishStepSpecs,
  postgresPublishRecords,
  postgresPublishStore,
} from "../../src/agentWork/publishOnce.js";
import {
  createFakePublishRecords,
  createFakePublishStore,
} from "../../src/agentWork/fakePublishStore.js";
import { isRecord } from "../../src/util/typeGuards.js";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import * as intentRepository from "../../src/agentWork/operationIntentRepository.js";
import * as reconciliation from "../../src/agentWork/reconcilePendingIntents.js";
import * as durableJob from "../../src/agentWork/durableJob.js";
import type { DurableJobSpec } from "../../src/agentWork/durableJob.js";
import { acquirePrActorLease } from "../../src/agentWork/prActorLease.js";
import {
  claimWorkForExecution,
  beginWorkAttempt,
  getWorkItem,
} from "../../src/agentWork/workItemStateRepository.js";
import {
  loadReviewExecutorPublishContext,
  recordReviewCheckRun,
} from "../../src/agentWork/publishRecordRepository.js";
import { retryDispositionFor } from "../../src/agentWork/retryPolicy.js";
import { AppError } from "../../src/errors/appError.js";
import type { ReviewJobData } from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import {
  claimSummaryCommentCreation,
  ownVerdictCloseOperationKey,
} from "../../src/agentWork/publishRecordRepository.js";
import { type PublishStep } from "../../src/agentWork/publishOnce.js";
import { saveVerificationThreadLedger } from "../../src/agentWork/verificationThreadLedger.js";
import { WORKER_CONSUMER_QUEUES, WORKER_DLQ_QUEUES } from "../../src/agentWork/workerHealth.js";
import * as analytics from "../../src/analytics/index.js";
import * as evlog from "../../src/evlog.js";
import {
  captureCiStateChanged,
  recordWorkCompleted,
  captureWebhookReceived,
  captureWorkRetried,
} from "../../src/analytics/workCompleted.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as surfaceFactory from "../../src/github/prSurface.js";
import { withPrSurfaceMutationBoundary } from "../../src/github/prSurfaceMutation.js";
import { recoverPrSurfaceMutation } from "../../src/github/recoverPrSurfaceMutation.js";
import { findReviewCheckRunByName } from "../../src/github/reviewPublish.js";
import { CHECK_RUNS_MAX_PAGES, CHECK_RUNS_PAGE_SIZE } from "../../src/settings/index.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../src/review/reviewSchema.js";
import { initialProgressTickState } from "../../src/review/run/progressComment.js";
import {
  parseProgressRevisionState,
  withProgressRevisionComment,
} from "../../src/review/run/commentMarkers.js";
import { createReviewWorkExecution } from "../../src/agentWork/executors/reviewExecutor.js";
import { tickProgressComment } from "../../src/review/orchestrator/stubTick.js";
import {
  renderReviewPointerLensMarker,
  renderStaleReviewMetadataComment,
} from "../../src/review/run/reviewRender.js";
import {
  renderCiRollupMarker,
  renderCiActionPhrase,
  renderCiSummaryCell,
  renderClearedVerificationFailureStub,
} from "../../src/review/ci/ciSummaryCell.js";
import { wrapDescriptionAgentBlock } from "../../src/agent/description/descriptionBodyMerge.js";
import { makeTestConfig } from "../helpers/config.js";
import {
  runInOperationIntentFrame,
  publishOnce,
  operationIntentMarker,
  type PublishOnceParams,
  askReplyOperationKey,
  askFailureReplyOperationKey,
  descriptionPrBodyOperationKey,
  deterministicInlineBatchId,
  reviewInlineBatchOperationKey,
  reviewSummaryOperationKey,
  triagePushOperationKey,
  triageThreadOperationKey,
  triageReportOperationKey,
  triagePreviewOperationKey,
  verificationThreadOperationKey,
  verificationFailureOperationKey,
  reviewCheckOperationKey,
  reviewCommitStatusOperationKey,
  reviewLabelsOperationKey,
} from "../../src/agentWork/publishOnce.js";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";
import { publishTriage, recoverTriagePublication } from "../../src/agent/triage/publishTriage.js";
import {
  openReviewArtifactStore,
  REVIEW_ARTIFACT_BUDGET_BYTES,
  REVIEW_SETTLEMENT_RESERVE_BYTES,
} from "../../src/agentWork/reviewArtifactRepository.js";
import {
  createReviewArtifactBinding,
  createReviewArtifactEnvelope,
  reviewArtifactHash,
} from "../../src/review/recovery/reviewArtifacts.js";
import { reviewPayloadFromFindings } from "../../src/review/reviewSchema.js";
import {
  createEvidenceLedger,
  recordDeliveredFileRead,
  revalidateEvidenceDescriptors,
} from "../../src/review/findings/evidenceLedger.js";

describe("review artifact evidence descriptors", () => {
  it("revalidates fresh governed reads rather than replaying response hashes as range hashes", async () => {
    const original = createEvidenceLedger("head");
    recordDeliveredFileRead(original, {
      path: "./src/a.ts",
      headSha: "head",
      tool: "readWorkspaceFile",
      startLine: 10,
      endLine: 13,
      content: "one\r\ntwo\r\nclamped\r\nfour",
      clampedLines: [12],
    });
    expect(original.covers("src/a.ts", 10, 11)).toBe(true);
    expect(original.covers("src/a.ts", 12, 12)).toBe(false);
    const descriptors = original.snapshot().map((read) => read.descriptor);
    expect(descriptors).toEqual([
      expect.objectContaining({ version: 1, kind: "file_range", startLine: 10, endLine: 11 }),
      expect.objectContaining({ version: 1, kind: "file_range", startLine: 13, endLine: 13 }),
    ]);
    const fresh = createEvidenceLedger("head");
    const read = vi.fn(async (descriptor: { startLine: number; endLine: number }) => ({
      path: "src/a.ts",
      headSha: "head",
      tool: "readWorkspaceFile",
      startLine: descriptor.startLine,
      endLine: descriptor.endLine,
      content: descriptor.startLine === 10 ? "one\ntwo" : "four",
    }));
    expect(await revalidateEvidenceDescriptors(fresh, descriptors, read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(fresh.covers("src/a.ts", 10, 11)).toBe(true);
    expect(fresh.covers("src/a.ts", 12, 12)).toBe(false);
    const mismatch = createEvidenceLedger("head");
    expect(
      await revalidateEvidenceDescriptors(mismatch, descriptors, async (descriptor) => ({
        path: descriptor.path,
        headSha: "head",
        tool: "readWorkspaceFile",
        startLine: descriptor.startLine,
        endLine: descriptor.endLine,
        content: "different",
      })),
    ).toBe(false);
    expect(mismatch.snapshot()).toEqual([]);
    expect(
      await revalidateEvidenceDescriptors(
        mismatch,
        original.snapshot().map(({ descriptor: _descriptor, ...legacy }) => legacy),
        read,
      ),
    ).toBe(false);
    expect(mismatch.snapshot()).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)("inline review publish batches (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers a SIGKILLed review in a separate process with exact receipts, a fresh session and the complete summary-only ledger", async () => {
    // Process proof inventory: kill after the provider accepted but before its response;
    // preserve all four validated reports; steal only this dead child's lease;
    // restart the actual review entry with a newly admitted pinned reader; prove
    // receipt recovery never publishes a second inline batch; retain summary-only
    // source/reason/count/budget data; refuse unfinished work at cap; complete an
    // already-published summary from its receipt without another view or model.
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const artifactDir = join(root, "verify-artifacts/review-reliability");
    await mkdir(artifactDir, { recursive: true });
    const scriptPath = join(artifactDir, "recovery-child.mjs");
    const sourceUrl = pathToFileURL(join(root, "src/")).href;
    const sourceEntry = new URL("review/runReviewForWorkItem.ts", sourceUrl).href;
    await writeFile(
      scriptPath,
      `
import { Pool } from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
const sourceUrl = ${JSON.stringify(sourceUrl)};
const sourceEntry = ${JSON.stringify(sourceEntry)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const candidate = specifier.startsWith("file:") ? new URL(specifier) :
      specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
    if (candidate?.href.startsWith(sourceUrl) && candidate.pathname.endsWith(".js")) {
      candidate.pathname = candidate.pathname.slice(0, -3) + ".ts";
      return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const load = (path) => import(new URL(path, sourceUrl));
const { runReviewForWorkItem } = await load("review/runReviewForWorkItem.js");
const { createFakePrSurface } = await load("github/prSurface.js");
const { createFeaturePiSession } = await load("agent/runtime/createFeatureSession.js");
const { createFakePiSession } = await load("agent/runtime/fakePiSession.js");
const { createPinnedRepositoryReader } = await load("prWorkspace/repositoryReader.js");
const { createCachedPrDiffIndex, ingestListPullRequestFilesResult } = await load("review/placement/reviewDiffIndex.js");
const { buildReviewPreflightMetadataFromWorkspace } = await load("review/placement/reviewPreflightFiles.js");
const { acquirePrActorLease, releasePrActorLease, isPrActorLeaseHeld } = await load("agentWork/prActorLease.js");
const { claimWorkForExecution, beginWorkAttempt, getWorkItem, shouldSkipWork } = await load("agentWork/workItemStateRepository.js");
const { escalationForAttempt } = await load("agentWork/retryPolicy.js");
const { publishOnce } = await load("agentWork/publishOnce.js");
const { withPrSurfaceMutationBoundary } = await load("github/prSurfaceMutation.js");
const { reviewPayloadFromFindings } = await load("review/reviewSchema.js");
const { AppError } = await load("errors/appError.js");
const { initEvlog } = await load("evlog.js");
initEvlog("error", { silent: true, suppressDrainWarning: true });
Math.random = () => 0;
const [dir, stage] = process.argv.slice(2);
const input = JSON.parse(await readFile(join(dir, "input.json"), "utf8"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let effects = { inlineCalls: 0, batches: [], comments: [], upserts: [] };
try { effects = JSON.parse(await readFile(join(dir, "remote.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const persistEffects = () => writeFile(join(dir, "remote.json"), JSON.stringify(effects, null, 2));
const key = { resourceKey: input.resourceKey, workType: "review" };
const lease = await acquirePrActorLease(pool, { ...key, workItemId: input.id, holderId: "proof-" + process.pid, ttlSeconds: 60 });
if (!lease.acquired) throw new Error("proof lease unavailable");
let claim = await claimWorkForExecution(pool, input.id, lease.leaseEpoch);
const item = await getWorkItem(pool, input.id);
const raw = createFakePrSurface({ owner: item.owner, repo: item.repo, prNumber: 1 }, { headSha: input.head });
raw.controls.setPullRequestReviews(effects.batches);
raw.controls.setReviewComments(effects.comments);
raw.controls.setProgressComment("## PR Agent Review", effects.upserts.at(-1) ?? "Queued", 99);
const originalUpsert = raw.surface.upsertProgressComment.bind(raw.surface);
raw.surface.upsertProgressComment = async (...args) => {
  const result = await originalUpsert(...args);
  effects.upserts.push(args[0]);
  await persistEffects();
  if (stage === "summary-crash" && args[0].includes("Mergeability")) {
    process.send?.({ kind: "boundary", pid: process.pid, leaseEpoch: lease.leaseEpoch, step: "summary", sourceEntry });
    await new Promise(() => {});
  }
  return result;
};
raw.surface.publishThreadBatch = async (review) => {
  effects.inlineCalls += 1;
  const id = 700 + effects.inlineCalls;
  effects.batches.push({ id, userId: 1, authorLogin: "pr-agent[bot]", body: review.body,
    commitId: review.commitId, htmlUrl: "https://github.com/" + item.owner + "/" + item.repo + "/pull/1#pullrequestreview-" + id });
  for (const [index, comment] of (review.comments ?? []).entries()) effects.comments.push({
    id: id * 10 + index, inReplyToId: null, pullRequestReviewId: id, userId: 1,
    authorLogin: "pr-agent[bot]", body: comment.body, path: comment.path, line: comment.line,
    originalLine: comment.line, htmlUrl: "https://github.com/" + item.owner + "/" + item.repo + "/pull/1#discussion_r" + (id * 10 + index),
  });
  await persistEffects();
  raw.controls.setPullRequestReviews(effects.batches);
  raw.controls.setReviewComments(effects.comments);
  if (stage === "crash") {
    process.send?.({ kind: "boundary", pid: process.pid, leaseEpoch: lease.leaseEpoch, sourceEntry });
    await new Promise(() => {});
  }
  return { reviewId: id, reviewUrl: effects.batches.at(-1).htmlUrl };
};
const signal = new AbortController().signal;
const surface = withPrSurfaceMutationBoundary(raw.surface, {
  signal, run: async (mutation, mutate) => {
    if (!(await isPrActorLeaseHeld(pool, item.id, lease.leaseEpoch)) || await shouldSkipWork(pool, item))
      throw new AppError({ domain: "agent_work", kind: "execution_aborted", message: "proof execution fenced" });
    return publishOnce({ ...mutation, client: pool, workItemId: item.id, leaseEpoch: lease.leaseEpoch, mutate });
  },
});
const finding = (source) => ({
  severity: source === "correctness" ? "P1" : "P2", file: "src/a.ts",
  startLine: source === "correctness" ? 2 : 3, endLine: source === "correctness" ? 2 : 3,
  title: source === "correctness" ? "Null input dereference" : "Unhandled stale input",
  detail: source === "correctness" ? "A null request dereferences its missing value before validation." :
    "A stale request reaches the new branch and returns an invalid result.",
  fixPrompt: "Guard this input before returning the result.",
});
const createSession = (params) => createFeaturePiSession({
  ...params, eventSink: (event) => appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify({
    pid: process.pid, sessionId: event.sessionId, generationId: event.generationId,
    kind: event.kind, role: event.role, phase: event.phase, specialist: event.specialistId, failureCode: event.failureCode,
  }) + "\\n"),
  createSession: (sessionParams) => createFakePiSession(sessionParams, async ({ prompt, opts }) => {
    if (sessionParams.role === "specialist") {
      const source = sessionParams.specialistId;
      await sessionParams.executors.execute({ code: 'await tools.readWorkspaceFile({ path: "src/a.ts", startLine: 1, maxLines: 3 })' });
      if (source === "quality") await new Promise((resolve) => setTimeout(resolve, 40));
      await sessionParams.executors.submit_findings_report(
        source === "correctness" || source === "quality" ?
          { status: "findings", findings: [finding(source)] } : { status: "no_findings", findings: [] });
    } else if (opts.phase === "recon") {
      await sessionParams.executors.submit_specialist_brief({
        prIntent: "Guard request inputs", architectureNotes: "One guarded request boundary", riskAreas: [],
        fileMap: "src/a.ts", specialistFocus: { correctness: "Trace null input", security: "Trace trust",
          quality: "Trace stale input", tests: "Trace regressions" },
      });
    } else if (opts.phase === "judgment") {
      const source = prompt.match(/Judge the (correctness|security|quality|tests) specialist/)[1];
      await sessionParams.executors.publish_thread({ findings: [finding(source)] });
    } else if (opts.phase === "synthesis") {
      await sessionParams.executors.publish_summary({ ...reviewPayloadFromFindings([]), size: "S" });
    }
    return { text: "Validated deterministic proof output", end: "completed" };
  }).session,
});
let admissions = 0;
let views = 0;
let admission;
const executionId = randomUUID();
const env = {
  job: { id: randomUUID(), data: { workItemId: item.id }, startedOn: new Date(), expireInSeconds: 120 },
  prSurface: surface, headSha: input.head, pullRequest: {
    title: "Guard request inputs", body: "Reject null and stale inputs", additions: 3, deletions: 0, changed_files: 1,
    head: { sha: input.head, repo: { full_name: item.owner + "/" + item.repo } },
    base: { sha: input.base, repo: { full_name: item.owner + "/" + item.repo } },
  },
  leaseEpoch: lease.leaseEpoch, signal,
  beginAttempt: () => admission ??= (async () => {
    admissions += 1;
    const result = await beginWorkAttempt(pool, item.id, lease.leaseEpoch, 4);
    if (result.kind !== "started") throw new AppError({ domain: "agent_work",
      kind: result.kind === "exhausted" ? "attempts_exhausted" : "admission_unavailable", message: "proof admission refused" });
    claim = { ...result.claim, resumed: claim.resumed };
    return claim;
  })(),
  get claim() { return claim; },
  get escalation() { return escalationForAttempt(claim.attemptCount, input.cfg); },
  durability: { pool, workItemId: item.id, installationId: 42, owner: item.owner, repo: item.repo,
    prNumber: 1, executionId, get attemptCount() { return claim.attemptCount; } },
  shouldAbortPublish: async () => await shouldSkipWork(pool, item) || !(await isPrActorLeaseHeld(pool, item.id, lease.leaseEpoch)),
  withAdmittedRepositoryView: async (_options, run) => {
    await env.beginAttempt();
    views += 1;
    const files = { files: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 0,
      changes: 3, patch: "@@ -0,0 +1,3 @@\\n+export const handler = input => {\\n+  return input.value;\\n+};" }],
      headSha: input.head, truncated: false, omittedCountLowerBound: 0, totalChanges: 3 };
    const diffIndex = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(diffIndex, files);
    const changedFiles = [{ path: "src/a.ts", status: "modified" }];
    const pinned = createPinnedRepositoryReader({
      agentCwd: join(dir, "workspace"), privateGitDir: join(dir, "workspace/.git"), headSha: input.head,
      checkoutPaths: new Set(["src/a.ts"]), sortedCheckoutPaths: ["src/a.ts"], checkoutMode: "full",
      changedFiles, changedFileByPath: new Map([["src/a.ts", changedFiles[0]]]), diffIndex,
      stats: { truncated: false, totalChanges: 3, fileCount: 1 },
      patchByPath: new Map([["src/a.ts", files.files[0].patch]]), patchOmittedByCapPaths: new Set(), symbolIndex: null,
    });
    const workspace = { rootDir: join(dir, "workspace"), agentCwd: join(dir, "workspace"),
      privateGitDir: join(dir, "workspace/.git"), reader: pinned.reader, cleanup: async () => pinned.dispose() };
    try { return await run({ workspace, agentCwd: workspace.agentCwd, preflight: buildReviewPreflightMetadataFromWorkspace(workspace) }); }
    finally { pinned.dispose(); }
  },
};
try {
  const result = await runReviewForWorkItem(item, env, {
    cfg: input.cfg, pool, boss: { send: async () => null, sendDebounced: async () => randomUUID() },
    getBotIdentity: async () => ({ userId: 1, login: "pr-agent[bot]" }), createSession,
  });
  process.send?.({ kind: "completed", result, pid: process.pid, executionId, admissions, views,
    attemptCount: claim.attemptCount, leaseEpoch: lease.leaseEpoch });
} catch (error) {
  process.send?.({ kind: "failed", code: error.code, message: error.message, reason: error.context?.reason,
    pid: process.pid, admissions, views });
} finally {
  await releasePrActorLease(pool, { ...key, leaseEpoch: lease.leaseEpoch });
  await pool.end();
  process.disconnect?.();
}
`,
    );
    const outcomes: Record<string, unknown>[] = [];
    const children = new Set<ReturnType<typeof fork>>();
    const cfg = makeTestConfig({
      review: { recoveryEnabled: true, maxInlineComments: 1, maxThreadPublishCalls: 1 },
      findingHistory: { enabled: false },
      agentEvents: { enabled: false },
      features: { reviewLabels: "off" },
    });
    const start = (dir: string, stage: string) => {
      const child = fork(scriptPath, [dir, stage], {
        cwd: root,
        silent: true,
        execArgv: ["--experimental-strip-types"],
      });
      children.add(child);
      let output = "";
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      const message = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Proof child timeout: ${output}`));
        }, 30_000);
        child.on("message", (value: unknown) => {
          if (!isRecord(value)) return;
          clearTimeout(timer);
          resolve(value);
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 && signal !== "SIGKILL")
            reject(new Error(`Proof child exited ${code}: ${output}`));
        });
      });
      return { child, message, output: () => output };
    };
    const stop = (child: ReturnType<typeof fork>) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    const fixtureIds: string[] = [];
    try {
      for (const { atCap, summaryCrash } of [
        { atCap: false, summaryCrash: false },
        { atCap: true, summaryCrash: false },
        { atCap: false, summaryCrash: true },
      ]) {
        const id = randomUUID();
        fixtureIds.push(id);
        const resourceKey = `crash-it/r-${id}#1`;
        const dir = join(artifactDir, id);
        await mkdir(join(dir, "workspace/src"), { recursive: true });
        await writeFile(
          join(dir, "workspace/src/a.ts"),
          "export const handler = input => {\n  return input.value;\n};\n",
        );
        await writeFile(
          join(dir, "input.json"),
          JSON.stringify({
            id,
            resourceKey,
            head: "a".repeat(40),
            base: "b".repeat(40),
            cfg,
          }),
        );
        await pool.query(
          `INSERT INTO agent_work_items
            (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens,
             resource_key, payload, attempt_count)
           VALUES ($1, 'review', 'slash', 'queued', 'crash-it', $2, 1, 42, $3, 'review', $4,
             '{"source":"slash","mode":"review"}', 1)`,
          [id, `r-${id}`, "a".repeat(40), resourceKey],
        );
        const initial = start(dir, summaryCrash ? "summary-crash" : "crash");
        const boundary = await initial.message;
        await writeFile(
          join(dir, "initial-outcome.json"),
          JSON.stringify({ boundary, output: initial.output() }, null, 2),
        );
        expect(boundary.kind).toBe("boundary");
        expect(boundary.sourceEntry).toBe(sourceEntry);
        for (let poll = 0; poll < 200; poll++) {
          const { rows } = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM review_run_artifacts WHERE work_item_id = $1 AND kind = 'report'",
            [id],
          );
          if (rows[0]?.count === 4) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const before = await pool.query<{
          logical_key: string;
          payload_hash: string;
          envelope: string;
        }>(
          "SELECT logical_key, payload_hash, envelope FROM review_run_artifacts WHERE work_item_id = $1 ORDER BY artifact_order",
          [id],
        );
        expect(before.rows.filter((row) => row.logical_key.startsWith("report/"))).toHaveLength(4);
        expect(before.rows.some((row) => row.logical_key === "decision/0/prepared")).toBe(true);
        expect(before.rows.some((row) => row.logical_key === "decision/0/settled")).toBe(
          summaryCrash,
        );
        if (summaryCrash) {
          expect(before.rows.some((row) => row.logical_key === "final-summary")).toBe(true);
          expect(before.rows.some((row) => row.logical_key === "decision/2/prepared")).toBe(true);
          expect(before.rows.some((row) => row.logical_key === "decision/2/settled")).toBe(false);
        }
        await stop(initial.child);
        expect(initial.child.signalCode).toBe("SIGKILL");
        // This is the dead process's dedicated lease, not a shared queue or live holder.
        await pool.query(
          "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
          [id],
        );
        if (atCap)
          await pool.query("UPDATE agent_work_items SET attempt_count = 4 WHERE id = $1", [id]);
        const resumed = start(dir, "resume");
        const resumedOutcome = await resumed.message;
        await new Promise<void>((resolve) => {
          if (resumed.child.exitCode !== null) resolve();
          else resumed.child.once("exit", () => resolve());
        });
        const remote = JSON.parse(await readFile(join(dir, "remote.json"), "utf8"));
        expect(remote.inlineCalls).toBe(1);
        const after = await pool.query<{
          logical_key: string;
          payload_hash: string;
          envelope: string;
        }>(
          "SELECT logical_key, payload_hash, envelope FROM review_run_artifacts WHERE work_item_id = $1 ORDER BY artifact_order",
          [id],
        );
        await writeFile(join(dir, "artifacts-after.json"), JSON.stringify(after.rows, null, 2));
        await writeFile(
          join(dir, "resumed-outcome.json"),
          JSON.stringify({ resumedOutcome, output: resumed.output() }, null, 2),
        );
        expect(resumedOutcome.kind).toBe(atCap ? "failed" : "completed");
        expect(resumedOutcome.admissions).toBe(1);
        expect(resumedOutcome.views).toBe(atCap ? 0 : 1);
        for (const retained of before.rows)
          expect(
            after.rows.find((row) => row.logical_key === retained.logical_key)?.payload_hash,
          ).toBe(retained.payload_hash);
        if (atCap) {
          expect(resumedOutcome.code).toBe("agent_work.attempts_exhausted");
          expect(after.rows).toEqual(before.rows);
        } else {
          expect(resumedOutcome.attemptCount).toBe(3);
          expect(resumedOutcome.leaseEpoch).not.toBe(boundary.leaseEpoch);
          const summary = after.rows.find((row) => row.logical_key === "final-summary");
          const envelope = summary ? JSON.parse(summary.envelope) : null;
          expect(envelope?.artifact.inputs.ledger).toMatchObject({
            postedInlineCount: 1,
            threadCallCount: 2,
            threadBudgetExhausted: true,
            accepted: [
              expect.objectContaining({ source: "correctness", kind: "posted" }),
              expect.objectContaining({
                source: "quality",
                kind: "summary_only",
                reason: "budget",
              }),
            ],
          });
          const sessions = (await readFile(join(dir, "sessions.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const originalIds = new Set(
            sessions.filter((event) => event.pid === boundary.pid).map((event) => event.sessionId),
          );
          const newSessions = sessions.filter((event) => event.pid === resumedOutcome.pid);
          if (summaryCrash) {
            expect(newSessions).toEqual([]);
            expect(
              remote.upserts.filter((body: string) => body.includes("Mergeability")),
            ).toHaveLength(1);
          } else {
            expect(newSessions.length).toBeGreaterThan(0);
          }
          expect(newSessions.every((event) => !originalIds.has(event.sessionId))).toBe(true);
          expect(
            newSessions.some((event) => event.role === "specialist" || event.phase === "recon"),
          ).toBe(false);
          expect(
            newSessions.filter((event) => event.kind === "turn" && event.phase === "judgment"),
          ).toHaveLength(summaryCrash ? 0 : 1);
          const publish = await loadReviewExecutorPublishContext(pool, id, resourceKey, "review");
          expect(publish.publishState.summaryPublished).toBe(true);
          await pool.query("UPDATE agent_work_items SET attempt_count = 4 WHERE id = $1", [id]);
          const receipt = start(dir, "receipt");
          const receiptOutcome = await receipt.message;
          await new Promise<void>((resolve) => {
            if (receipt.child.exitCode !== null) resolve();
            else receipt.child.once("exit", () => resolve());
          });
          await writeFile(
            join(dir, "receipt-outcome.json"),
            JSON.stringify({ receiptOutcome, output: receipt.output() }, null, 2),
          );
          expect(receiptOutcome.kind).toBe("completed");
          expect(receiptOutcome.admissions).toBe(0);
          expect(receiptOutcome.views).toBe(0);
          outcomes.push({
            boundary,
            resumedOutcome,
            receiptOutcome,
            id,
            ledger: envelope.artifact.inputs.ledger,
            artifactKeys: after.rows.map((row) => row.logical_key),
            independentSessionIds: [...new Set(newSessions.map((event) => event.sessionId))],
            inlineCalls: remote.inlineCalls,
            summaryRecoveredWithoutModel: summaryCrash,
          });
        }
        if (atCap)
          outcomes.push({
            boundary,
            resumedOutcome,
            id,
            inlineCalls: remote.inlineCalls,
            artifactsUnchanged: true,
          });
      }
      await writeFile(
        join(artifactDir, "process-restart-proof.json"),
        JSON.stringify(
          {
            command:
              "DATABASE_URL=postgresql://pr_agent@127.0.0.1:32897/pr_agent_review_recovery_acceptance node_modules/.bin/vitest run -c vitest.integration.config.ts test/integration/publishRecordBatches.integration.test.ts -t SIGKILLed",
            signal: "SIGKILL",
            productionEntry: "runReviewForWorkItem",
            sourceEntry,
            runtime: "Node native TypeScript with source-only .js import resolution",
            outcomes,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const child of children) await stop(child);
      for (const id of fixtureIds) {
        await pool.query(
          "DELETE FROM pr_actor_leases WHERE work_item_id = $1 OR resource_key = $2",
          [id, `crash-it/r-${id}#1`],
        );
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [id]);
      }
    }
  }, 90_000);

  describe("bounded private review artifacts", () => {
    const brief = {
      prIntent: "Review the change",
      architectureNotes: "",
      riskAreas: [],
      fileMap: "",
      specialistFocus: { correctness: "", security: "", quality: "", tests: "" },
    };
    let binding: ReturnType<typeof createReviewArtifactBinding>;
    let store: ReturnType<typeof openReviewArtifactStore>;
    beforeEach(async () => {
      const id = randomUUID();
      const resourceKey = `artifact-it/r-${id}#1`;
      binding = createReviewArtifactBinding(
        {
          workItemId: id,
          resourceKey,
          owner: "artifact-it",
          repo: `r-${id}`,
          prNumber: 1,
          installationId: 42,
          baseSha: "base",
          headSha: "head",
          mode: "review",
        },
        "a".repeat(64),
      );
      await pool.query(
        `INSERT INTO agent_work_items
          (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload, execution_epoch)
         VALUES ($1, 'review', 'auto', 'running', $2, $3, 1, 42, 'head', 'review', $4, '{}', 7)`,
        [id, binding.owner, binding.repo, resourceKey],
      );
      await pool.query(
        `INSERT INTO pr_actor_leases (resource_key, work_type, lease_epoch, work_item_id, holder_id, expires_at)
         VALUES ($1, 'review', 7, $2, 'artifact-it', now() + interval '5 minutes')`,
        [resourceKey, id],
      );
      store = openReviewArtifactStore(pool, binding, 7);
    });
    afterEach(async () => {
      await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [
        binding.resourceKey,
      ]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [binding.workItemId]);
    });

    it("validates, redacts, binds immutable identity and handles identical retry", async () => {
      const envelope = createReviewArtifactEnvelope(binding, {
        kind: "brief",
        brief: { ...brief, architectureNotes: "OPENAI_API_KEY=sk-secret-value" },
      });
      expect(await store.save(envelope)).toBe("stored");
      expect(await store.save(envelope)).toBe("existing");
      expect(await store.load("brief")).toEqual(envelope);
      expect(JSON.stringify(await store.load("brief"))).not.toContain("sk-secret-value");
      await expect(
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "brief",
            brief: { ...brief, prIntent: "Changed" },
          }),
        ),
      ).rejects.toMatchObject({
        code: "publish_store.invalid_detail",
        context: { reason: "artifact_conflict" },
      });
      const { inputFingerprint: _inputFingerprint, ...identity } = binding;
      const other = createReviewArtifactBinding(
        { ...identity, headSha: "another" },
        "a".repeat(64),
      );
      expect(await openReviewArtifactStore(pool, other, 7).load("brief")).toBeNull();
      await expect(
        store.save(createReviewArtifactEnvelope(other, { kind: "brief", brief })),
      ).rejects.toMatchObject({ code: "publish_store.invalid_detail" });
      const changedInputs = createReviewArtifactBinding(identity, "b".repeat(64));
      const changedStore = openReviewArtifactStore(pool, changedInputs, 7);
      expect(await changedStore.load("brief")).toBeNull();
      expect(
        await changedStore.save(
          createReviewArtifactEnvelope(changedInputs, { kind: "brief", brief }),
        ),
      ).toBe("incompatible");
      expect(await store.load("brief")).toEqual(envelope);
      await expect(
        store.save({ ...envelope, artifact: { kind: "brief", brief, transcript: "forbidden" } }),
      ).rejects.toMatchObject({ code: "publish_store.invalid_detail" });
      const report = createReviewArtifactEnvelope(binding, {
        kind: "report",
        specialist: "correctness",
        report: { status: "no_findings", findings: [] },
        evidence: [],
      });
      await expect(
        store.save({
          ...report,
          artifact: {
            ...report.artifact,
            evidence: [
              {
                version: 1,
                kind: "file_range",
                path: "src/a.ts",
                startLine: 1,
                endLine: 1,
                contentHash: "a".repeat(64),
                headSha: "different",
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: "publish_store.invalid_detail" });
      const plan = createReviewArtifactEnvelope(binding, {
        kind: "publication_prepared",
        decisionId: "one",
        sequence: 0,
        operationKey: "review:batch:one",
        payload: reviewPayloadFromFindings([]),
        dependencies: [],
      });
      await expect(
        store.save({
          ...plan,
          artifact: { ...plan.artifact, operationKey: "token=secret-value" },
        }),
      ).rejects.toMatchObject({ code: "publish_store.invalid_detail" });
    });

    it.each(["stale", "null", "cancelled", "terminal", "wrong_execution"] as const)(
      "rejects %s write authority",
      async (state) => {
        if (state === "cancelled")
          await pool.query(
            "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
            [binding.workItemId],
          );
        if (state === "terminal")
          await pool.query("UPDATE agent_work_items SET status = 'completed' WHERE id = $1", [
            binding.workItemId,
          ]);
        if (state === "wrong_execution")
          await pool.query("UPDATE agent_work_items SET execution_epoch = 8 WHERE id = $1", [
            binding.workItemId,
          ]);
        const epoch = state === "stale" ? 6 : state === "null" ? null : 7;
        await expect(
          openReviewArtifactStore(pool, binding, epoch).save(
            createReviewArtifactEnvelope(binding, { kind: "brief", brief }),
          ),
        ).rejects.toMatchObject({
          code:
            state === "cancelled" || state === "terminal"
              ? "agent_work.execution_aborted"
              : "agent_work.pr_actor_lease_lost",
        });
        expect(
          (
            await pool.query("SELECT * FROM review_run_artifacts WHERE work_item_id = $1", [
              binding.workItemId,
            ])
          ).rows,
        ).toEqual([]);
      },
    );

    it("treats unknown versions and damaged hashes as cache misses", async () => {
      const envelope = createReviewArtifactEnvelope(binding, { kind: "brief", brief });
      await store.save(envelope);
      await pool.query("UPDATE review_run_artifacts SET envelope = $2 WHERE work_item_id = $1", [
        binding.workItemId,
        JSON.stringify({ ...envelope, contractVersion: "future" }),
      ]);
      expect(await store.load("brief")).toBeNull();
      expect(await store.save(envelope)).toBe("incompatible");
      expect(
        JSON.parse(
          (
            await pool.query<{ envelope: string }>(
              "SELECT envelope FROM review_run_artifacts WHERE work_item_id = $1 AND logical_key = 'brief'",
              [binding.workItemId],
            )
          ).rows[0].envelope,
        ),
      ).toMatchObject({ contractVersion: "future" });
      await pool.query("UPDATE review_run_artifacts SET envelope = $2 WHERE work_item_id = $1", [
        binding.workItemId,
        JSON.stringify({ ...envelope, schemaVersion: 0 }),
      ]);
      expect(await store.load("brief")).toBeNull();
      expect(await store.save(envelope)).toBe("incompatible");
      await pool.query(
        "UPDATE review_run_artifacts SET envelope = $2, payload_hash = repeat('0', 64) WHERE work_item_id = $1",
        [binding.workItemId, JSON.stringify(envelope)],
      );
      expect(await store.load("brief")).toBeNull();
      expect(await store.save(envelope)).toBe("incompatible");
      expect(
        (
          await pool.query<{ payload_hash: string }>(
            "SELECT payload_hash FROM review_run_artifacts WHERE work_item_id = $1 AND logical_key = 'brief'",
            [binding.workItemId],
          )
        ).rows[0].payload_hash,
      ).toBe("0".repeat(64));
      await pool.query("UPDATE review_run_artifacts SET envelope = $2 WHERE work_item_id = $1", [
        binding.workItemId,
        JSON.stringify({
          ...envelope,
          artifact: { kind: "brief", brief: { ...brief, prIntent: "token=x ".repeat(249) } },
        }),
      ]);
      expect(await store.load("brief")).toBeNull();
    });

    it("requires exact ordered dependencies and settles only the corresponding immutable decision", async () => {
      const envelope = createReviewArtifactEnvelope(binding, { kind: "brief", brief });
      await store.save(envelope);
      const prepared = createReviewArtifactEnvelope(binding, {
        kind: "publication_prepared",
        decisionId: "decision-one",
        sequence: 0,
        operationKey: "review:batch:one",
        payload: reviewPayloadFromFindings([]),
        dependencies: [{ logicalKey: "brief", payloadHash: reviewArtifactHash(envelope) }],
      });
      expect(await store.save(prepared)).toBe("stored");
      await expect(
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_settled",
            decisionId: "unrelated",
            sequence: 0,
            preparedHash: reviewArtifactHash(prepared),
            outcome: "accepted",
          }),
        ),
      ).rejects.toMatchObject({
        code: "publish_store.invalid_detail",
        context: { reason: "prepared_decision_mismatch" },
      });
      await expect(
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_prepared",
            decisionId: "decision-one",
            sequence: 0,
            operationKey: "review:batch:one",
            payload: reviewPayloadFromFindings([]),
            dependencies: [{ logicalKey: "brief", payloadHash: "0".repeat(64) }],
          }),
        ),
      ).rejects.toMatchObject({ code: "publish_store.invalid_detail" });
      const settled = createReviewArtifactEnvelope(binding, {
        kind: "publication_settled",
        decisionId: "decision-one",
        sequence: 0,
        preparedHash: reviewArtifactHash(prepared),
        outcome: "accepted",
      });
      expect(await store.save(settled)).toBe("stored");
      expect(await store.save(settled)).toBe("existing");
      await expect(
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_settled",
            decisionId: "decision-one",
            sequence: 0,
            preparedHash: reviewArtifactHash(prepared),
            outcome: "stopped",
          }),
        ),
      ).rejects.toMatchObject({
        code: "publish_store.invalid_detail",
        context: { reason: "artifact_conflict" },
      });
      expect(await store.load("decision/0/prepared")).toEqual(prepared);
      await expect(
        store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_settled",
            decisionId: "decision-one",
            sequence: 1,
            preparedHash: reviewArtifactHash(prepared),
            outcome: "accepted",
          }),
        ),
      ).rejects.toMatchObject({
        code: "publish_store.invalid_detail",
        context: { reason: "prepared_decision_missing" },
      });
    });

    it.each([
      "hash",
      "missing",
      "version",
      "identity",
      "dependency_hash",
      "duplicate",
      "cycle",
      "prepared_hash",
      "prepared_identity",
      "missing_prepared",
      "missing_previous",
    ] as const)(
      "misses dependent artifacts after %s corruption without changing rows",
      async (damage) => {
        const original = createReviewArtifactEnvelope(binding, { kind: "brief", brief });
        const first = createReviewArtifactEnvelope(binding, {
          kind: "publication_prepared",
          decisionId: "first",
          sequence: 0,
          operationKey: "review:batch:first",
          payload: reviewPayloadFromFindings([]),
          dependencies: [{ logicalKey: "brief", payloadHash: reviewArtifactHash(original) }],
        });
        const settled = createReviewArtifactEnvelope(binding, {
          kind: "publication_settled",
          decisionId: "first",
          sequence: 0,
          preparedHash: reviewArtifactHash(first),
          outcome: "accepted",
        });
        const second = createReviewArtifactEnvelope(binding, {
          kind: "publication_prepared",
          decisionId: "second",
          sequence: 1,
          operationKey: "review:batch:second",
          payload: reviewPayloadFromFindings([]),
          dependencies: [],
        });
        const summary = createReviewArtifactEnvelope(binding, {
          kind: "final_summary",
          payload: reviewPayloadFromFindings([]),
          dependencies: [
            { logicalKey: second.logicalKey, payloadHash: reviewArtifactHash(second) },
          ],
        });
        for (const envelope of [original, first, settled, second, summary])
          expect(await store.save(envelope)).toBe("stored");
        for (const envelope of [first, settled, second, summary])
          expect(await store.load(envelope.logicalKey)).toEqual(envelope);

        if (
          damage === "missing" ||
          damage === "missing_prepared" ||
          damage === "missing_previous"
        ) {
          await pool.query(
            "DELETE FROM review_run_artifacts WHERE work_item_id = $1 AND logical_key = $2",
            [
              binding.workItemId,
              damage === "missing"
                ? "brief"
                : damage === "missing_prepared"
                  ? first.logicalKey
                  : settled.logicalKey,
            ],
          );
        } else if (damage === "hash") {
          await pool.query(
            "UPDATE review_run_artifacts SET payload_hash = repeat('0', 64) WHERE work_item_id = $1 AND logical_key = 'brief'",
            [binding.workItemId],
          );
        } else if (damage === "version") {
          await pool.query(
            "UPDATE review_run_artifacts SET envelope = $2 WHERE work_item_id = $1 AND logical_key = 'brief'",
            [binding.workItemId, JSON.stringify({ ...original, contractVersion: "future" })],
          );
        } else {
          const corrupted =
            damage === "identity"
              ? { ...original, binding: { ...binding, headSha: "another" } }
              : damage === "prepared_hash" || damage === "prepared_identity"
                ? createReviewArtifactEnvelope(binding, {
                    kind: "publication_settled",
                    sequence: 0,
                    outcome: "accepted",
                    preparedHash:
                      damage === "prepared_hash" ? "0".repeat(64) : reviewArtifactHash(first),
                    decisionId: damage === "prepared_identity" ? "another" : "first",
                  })
                : createReviewArtifactEnvelope(binding, {
                    kind: "publication_prepared",
                    decisionId: "first",
                    sequence: 0,
                    operationKey: "review:batch:first",
                    payload: reviewPayloadFromFindings([]),
                    dependencies:
                      damage === "duplicate"
                        ? [
                            { logicalKey: "brief", payloadHash: reviewArtifactHash(original) },
                            { logicalKey: "brief", payloadHash: reviewArtifactHash(original) },
                          ]
                        : [
                            {
                              logicalKey: damage === "cycle" ? second.logicalKey : "brief",
                              payloadHash:
                                damage === "cycle" ? reviewArtifactHash(second) : "0".repeat(64),
                            },
                          ],
                  });
          // Keep the envelope's own hash valid so dependency/link checks, not decoding, reject it.
          await pool.query(
            "UPDATE review_run_artifacts SET envelope = $3, payload_hash = $4 WHERE work_item_id = $1 AND logical_key = $2",
            [
              binding.workItemId,
              corrupted.logicalKey,
              JSON.stringify(corrupted),
              reviewArtifactHash(corrupted),
            ],
          );
        }
        const before = await pool.query(
          "SELECT * FROM review_run_artifacts WHERE work_item_id = $1 ORDER BY logical_key",
          [binding.workItemId],
        );
        expect(await store.load(second.logicalKey)).toBeNull();
        expect(await store.load(summary.logicalKey)).toBeNull();
        expect(await store.save(second)).toBe("incompatible");
        expect(await store.save(summary)).toBe("incompatible");
        if (damage !== "missing_previous") {
          expect(await store.load(settled.logicalKey)).toBeNull();
          if (damage !== "prepared_hash" && damage !== "prepared_identity")
            expect(await store.load(first.logicalKey)).toBeNull();
        }
        expect(
          (
            await pool.query(
              "SELECT * FROM review_run_artifacts WHERE work_item_id = $1 ORDER BY logical_key",
              [binding.workItemId],
            )
          ).rows,
        ).toEqual(before.rows);
      },
    );

    it("serializes concurrent budget admission and reserves settlement before a plan", async () => {
      const prepared = createReviewArtifactEnvelope(binding, {
        kind: "publication_prepared",
        decisionId: "last-plan",
        sequence: 0,
        operationKey: "review:batch:last",
        payload: reviewPayloadFromFindings([]),
        dependencies: [],
      });
      const envelopeBytes = Buffer.byteLength(JSON.stringify(prepared), "utf8");
      const fillerBytes =
        REVIEW_ARTIFACT_BUDGET_BYTES - envelopeBytes - REVIEW_SETTLEMENT_RESERVE_BYTES;
      await pool.query(
        `INSERT INTO review_run_artifacts (work_item_id, logical_key, artifact_order, kind, input_fingerprint, payload_hash, envelope)
         VALUES ($1, 'fixture-filler', 999, 'brief', $2, repeat('f', 64), $3)`,
        [
          binding.workItemId,
          binding.inputFingerprint,
          `{"padding":"${"x".repeat(fillerBytes - 14)}"}`,
        ],
      );
      expect(await store.save(prepared)).toBe("stored");
      const reports = ["correctness", "security"] as const;
      expect(
        await Promise.all(
          reports.map((specialist) =>
            store.save(
              createReviewArtifactEnvelope(binding, {
                kind: "report",
                specialist,
                report: { status: "no_findings", findings: [] },
                evidence: [],
              }),
            ),
          ),
        ),
      ).toEqual(["capacity", "capacity"]);
      expect(
        await store.save(
          createReviewArtifactEnvelope(binding, {
            kind: "publication_settled",
            decisionId: "last-plan",
            sequence: 0,
            preparedHash: reviewArtifactHash(prepared),
            outcome: "recovered",
          }),
        ),
      ).toBe("stored");
      const usage = await pool.query<{ bytes: string }>(
        "SELECT SUM(encoded_bytes + reserved_bytes) AS bytes FROM review_run_artifacts WHERE work_item_id = $1",
        [binding.workItemId],
      );
      expect(Number(usage.rows[0]?.bytes)).toBeLessThanOrEqual(REVIEW_ARTIFACT_BUDGET_BYTES);
    });

    it("allows only one winner when concurrent writes each fit but their sum does not", async () => {
      const envelope = createReviewArtifactEnvelope(binding, {
        kind: "report",
        specialist: "correctness",
        report: { status: "no_findings", findings: [] },
        evidence: [],
      });
      const bytes = Buffer.byteLength(JSON.stringify(envelope));
      await pool.query(
        `INSERT INTO review_run_artifacts (work_item_id, logical_key, artifact_order, kind, input_fingerprint, payload_hash, envelope)
         VALUES ($1, 'fixture-filler', 999, 'brief', $2, repeat('f', 64), $3)`,
        [
          binding.workItemId,
          binding.inputFingerprint,
          `{"padding":"${"x".repeat(REVIEW_ARTIFACT_BUDGET_BYTES - bytes - 32 - 14)}"}`,
        ],
      );
      const results = await Promise.all(
        (["correctness", "security"] as const).map((specialist) =>
          store.save(
            createReviewArtifactEnvelope(binding, {
              kind: "report",
              specialist,
              report: { status: "no_findings", findings: [] },
              evidence: [],
            }),
          ),
        ),
      );
      expect(results.toSorted()).toEqual(["capacity", "stored"]);
      const usage = await pool.query<{ bytes: string }>(
        "SELECT SUM(encoded_bytes + reserved_bytes) AS bytes FROM review_run_artifacts WHERE work_item_id = $1",
        [binding.workItemId],
      );
      expect(Number(usage.rows[0]?.bytes)).toBeLessThanOrEqual(REVIEW_ARTIFACT_BUDGET_BYTES);
    });
  });

  it.each(["postgres", "fake"] as const)(
    "keeps completion scopes and batches through %s",
    async (adapter) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/publish-owner-${randomUUID()}#1`;
      await pool.query(
        `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey],
      );
      try {
        const records =
          adapter === "postgres"
            ? postgresPublishRecords
            : createFakePublishRecords(publishStepSpecs);
        const ctx = createPublishContext(
          pool,
          {
            workItemId,
            resourceKey,
            reviewLens: "review",
            leaseEpoch: null,
          },
          records,
        );
        await expect(ctx.record({ step: "ask_reply", detail: {} })).rejects.toMatchObject({
          code: "agent_work.publish_lens_mismatch",
        });
        await expect(
          createPublishContext(
            pool,
            {
              workItemId,
              resourceKey,
              reviewLens: "ask",
              leaseEpoch: null,
            },
            records,
          ).record({ step: "summary_comment", detail: {} }),
        ).rejects.toMatchObject({ code: "agent_work.publish_lens_mismatch" });
        expect(await ctx.completed("inline_review")).toBeNull();
        await ctx.record({
          step: "inline_review",
          detail: { batchId: "first", fingerprints: ["one"] },
        });
        await ctx.record({
          step: "inline_review",
          detail: { batchId: "second", fingerprints: ["two"] },
        });
        await ctx.record({
          step: "inline_review",
          detail: { batchId: "first", fingerprints: ["one"] },
        });
        expect(await ctx.completed("inline_review")).toEqual({
          batches: [
            { batchId: "first", fingerprints: ["one"] },
            { batchId: "second", fingerprints: ["two"] },
          ],
        });
        const snapshot = await ctx.completed("inline_review");
        if (Array.isArray(snapshot?.batches) && isRecord(snapshot.batches[0]))
          snapshot.batches[0].batchId = "modified read";
        expect(await ctx.completed("inline_review")).toMatchObject({
          batches: [{ batchId: "first" }, { batchId: "second" }],
        });
        const incoming = { nested: { saved: true } };
        await ctx.record({ step: "triage_push", detail: incoming });
        incoming.nested.saved = false;
        expect(await ctx.latest("triage_push")).toEqual({ nested: { saved: true } });
        expect(await ctx.withoutNewer("triage_push", "triage_report")).toEqual({
          nested: { saved: true },
        });
        await ctx.record({ step: "triage_report", detail: { reported: true } });
        expect(await ctx.withoutNewer("triage_push", "triage_report")).toBeNull();
        expect(
          await createPublishContext(
            pool,
            {
              workItemId: randomUUID(),
              resourceKey,
              reviewLens: "review",
            },
            records,
          ).completed("inline_review"),
        ).toBeNull();
        await ctx.record({ step: "progress_comment", detail: { revision: 0, stubPostedAtMs: 7 } });
        await ctx.record({ step: "progress_comment", detail: { revision: 1 } });
        expect(await ctx.completed("progress_comment")).toEqual({ revision: 1, stubPostedAtMs: 7 });
        const foreignId = randomUUID();
        await pool.query(
          `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'ask', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', NULL, $2, '{}')`,
          [foreignId, resourceKey],
        );
        try {
          await expect(
            createPublishContext(
              pool,
              {
                workItemId: foreignId,
                resourceKey,
                reviewLens: "review",
                leaseEpoch: null,
              },
              records,
            ).record({ step: "progress_comment", detail: { revision: 2 } }),
          ).rejects.toMatchObject({ code: "agent_work.progress_comment_ownership_conflict" });
          const firstAsk = createPublishContext(
            pool,
            { workItemId, resourceKey, reviewLens: "ask", leaseEpoch: null },
            records,
          );
          const secondAsk = createPublishContext(
            pool,
            { workItemId: foreignId, resourceKey, reviewLens: "ask", leaseEpoch: null },
            records,
          );
          await firstAsk.record({ step: "ask_reply", detail: { reply: "first" } });
          await secondAsk.record({ step: "ask_reply", detail: { reply: "second" } });
          expect(await firstAsk.completed("ask_reply")).toEqual({ reply: "first" });
          expect(await secondAsk.completed("ask_reply")).toEqual({ reply: "second" });
        } finally {
          await pool.query("DELETE FROM agent_work_items WHERE id = $1", [foreignId]);
        }
        await acquirePrActorLease(pool, {
          resourceKey,
          workType: "review",
          workItemId,
          holderId: "m8-adapter",
          ttlSeconds: 120,
        });
        const leased = createPublishContext(
          pool,
          { workItemId, resourceKey, reviewLens: "review", leaseEpoch: 1 },
          records,
        );
        await leased.record({ step: "summary_comment", detail: { version: 1 } });
        await pool.query(
          "UPDATE pr_actor_leases SET holder_id = NULL, work_item_id = NULL WHERE resource_key = $1",
          [resourceKey],
        );
        await expect(
          leased.record({ step: "summary_comment", detail: { version: 2 } }),
        ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
        expect(await ctx.completed("summary_comment")).toEqual({ version: 1 });
      } finally {
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each(["postgres", "fake"] as const)(
    "retains isolated intent snapshots and fences transitions through %s",
    async (adapter) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/intent-adapter-${randomUUID()}#1`;
      await pool.query(
        `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{}')`,
        [workItemId, resourceKey],
      );
      const store = adapter === "postgres" ? postgresPublishStore : createFakePublishStore();
      const operationKey = `adapter:${resourceKey}`;
      const detail = { nested: { kept: true } };
      try {
        await acquirePrActorLease(pool, {
          resourceKey,
          workType: "review",
          workItemId,
          holderId: "m8-intent-adapter",
          ttlSeconds: 120,
        });
        const first = await store.persistOperationIntent(pool, {
          workItemId,
          operationKey,
          mutationKind: "github.test",
          leaseEpoch: 1,
          detail,
        });
        detail.nested.kept = false;
        expect(await store.getOperationIntent(pool, workItemId, operationKey)).toMatchObject({
          detail: { nested: { kept: true } },
        });
        const snapshot = await store.getOperationIntent(pool, workItemId, operationKey);
        if (isRecord(snapshot?.detail.nested)) snapshot.detail.nested.kept = false;
        expect(await store.getOperationIntent(pool, workItemId, operationKey)).toMatchObject({
          detail: { nested: { kept: true } },
        });
        const conflict = await store.persistOperationIntent(pool, {
          workItemId,
          operationKey,
          mutationKind: "github.other",
          leaseEpoch: 1,
          detail: { wrong: true },
        });
        expect(conflict).toMatchObject({
          id: first.id,
          mutationKind: "github.test",
          detail: { nested: { kept: true } },
        });
        await store.reconcileOperationIntent(pool, {
          workItemId,
          operationKey,
          status: "failed",
          leaseEpoch: 1,
        });
        await store.mergeOperationIntentDetail(pool, {
          workItemId,
          operationKey,
          leaseEpoch: 1,
          detail: { __mutating: true },
        });
        expect(await store.listPendingOperationIntents(pool, workItemId)).toMatchObject([
          { operationKey, status: "pending", detail: { __mutating: true } },
        ]);
        await pool.query(
          "UPDATE pr_actor_leases SET holder_id = NULL, work_item_id = NULL WHERE resource_key = $1",
          [resourceKey],
        );
        await expect(
          store.persistOperationIntent(pool, {
            workItemId,
            operationKey,
            mutationKind: "github.test",
            leaseEpoch: 1,
          }),
        ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
        await expect(
          store.mergeOperationIntentDetail(pool, {
            workItemId,
            operationKey,
            leaseEpoch: 1,
            detail: { changed: true },
          }),
        ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
        await expect(
          store.reconcileOperationIntent(pool, {
            workItemId,
            operationKey,
            status: "reconciled",
            leaseEpoch: 1,
          }),
        ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
        expect(await store.getOperationIntent(pool, workItemId, operationKey)).toMatchObject({
          status: "pending",
          detail: { __mutating: true },
        });
        await store.reconcileOperationIntent(pool, {
          workItemId,
          operationKey,
          status: "outcome_unknown",
          leaseEpoch: null,
        });
        expect(
          await store.mergeOperationIntentDetail(pool, {
            workItemId,
            operationKey,
            detail: { changed: true },
          }),
        ).toBeNull();
      } finally {
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each([
    "accepted",
    "partial",
    "wrong branch",
    "wrong inventory",
    "wrong remote branch",
    "wrong remote tip",
    "missing plan",
    "incomplete plan",
    "wrong retained base",
    "wrong retained inventory",
    "observation outage",
    "closed after acceptance",
    "cancel during evidence",
  ] as const)(
    "recovers interrupted triage from retained pre-push evidence: %s",
    async (scenario) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/triage-interrupted-${randomUUID()}#1`;
      const baseHeadSha = "a".repeat(40);
      const firstSha = "b".repeat(40);
      const pushedHeadSha = "c".repeat(40);
      const commits = [
        { sha: firstSha, subject: "fix: first", diff: "+first\n" },
        { sha: pushedHeadSha, subject: "fix: second", diff: "+second\n" },
      ];
      const payload = {
        verdicts: [
          { verdict: "fixed", threadRootCommentId: 1, commitSha: pushedHeadSha, evidence: "fixed" },
        ],
      };
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'triage', 'slash', 'running', 'o', 'r', 1, 42, $3, NULL, $2, '{}')`,
        [workItemId, resourceKey, baseHeadSha],
      );
      const operationKey = triagePushOperationKey(resourceKey);
      const pushPlan = {
        pushOutcome: "pushed",
        baseHeadSha:
          scenario === "incomplete plan"
            ? undefined
            : scenario === "wrong retained base"
              ? "d".repeat(40)
              : baseHeadSha,
        headRef: "branch",
        pushedHeadSha,
        pushedShas: [firstSha, pushedHeadSha],
        commits,
        payload,
        threadRootCommentIds: scenario === "wrong retained inventory" ? [2] : [1],
      };
      const fake = createFakePrSurface(
        { owner: "o", repo: "r", prNumber: 1 },
        { headSha: pushedHeadSha },
      );
      if (scenario === "wrong remote branch")
        fake.controls.setPullRequestBranchInfo({ headRef: "other", sameRepo: true });
      if (scenario === "wrong remote tip") fake.controls.setHeadSha(firstSha);
      if (scenario === "closed after acceptance")
        fake.controls.setPullRequest({
          additions: 1,
          deletions: 0,
          title: "",
          body: null,
          changed_files: 1,
          state: "closed",
          merged: false,
          merged_at: null,
          head: { sha: pushedHeadSha, ref: "branch", repo: { full_name: "o/r" } },
          base: { repo: { full_name: "o/r" } },
        });
      fake.controls.setPushedCommits(
        (scenario === "partial" ? commits.slice(0, 1) : commits).map((commit) => ({
          sha: commit.sha,
          subject: commit.subject,
        })),
      );
      const gitAuth = vi.spyOn(fake.surface, "gitCredentialAuth");
      try {
        await intentRepository.persistOperationIntent(pool, {
          workItemId,
          operationKey,
          mutationKind: "github.triage_push",
          detail: {
            step: "triage_push",
            resourceKey,
            reviewLens: "triage",
            ...(scenario !== "missing plan" ? { pushPlan } : {}),
            __mutating: true,
          },
        });
        if (scenario === "observation outage")
          vi.spyOn(fake.surface, "listPushedCommits").mockRejectedValue(
            new Error("temporary provider read failure"),
          );
        if (scenario === "cancel during evidence")
          vi.spyOn(fake.surface, "listPushedCommits").mockImplementation(async () => {
            await pool.query(
              "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
              [workItemId],
            );
            return commits;
          });
        const recovery = () =>
          recoverTriagePublication({
            pool,
            workItemId,
            resourceKey,
            installationId: 42,
            prSurface: fake.surface,
            owner: "o",
            repo: "r",
            prNumber: 1,
            headSha: pushedHeadSha,
            headRef: scenario === "wrong branch" ? "other" : "branch",
            inventory: [
              {
                rootCommentId: scenario === "wrong inventory" ? 2 : 1,
                lens: "review",
                path: "src/app.ts",
                line: 1,
                severity: "P1",
                titleSnippet: "Bug",
                humanReplies: [],
                threadUrl: "https://github.test/thread",
              },
            ],
            resolutionByRootCommentId: new Map(),
            previouslyResolvedCount: 0,
            leaseEpoch: null,
          });
        if (scenario === "accepted" || scenario === "closed after acceptance") {
          expect(await recovery()).toMatchObject({
            pushOutcome: scenario === "accepted" ? "pushed" : "closed",
          });
          const record = await createPublishContext(pool, {
            workItemId,
            resourceKey,
            reviewLens: "triage",
          }).completed("triage_push");
          expect(record).toMatchObject(
            scenario === "accepted"
              ? pushPlan
              : { pushOutcome: "closed", attemptedShas: pushPlan.pushedShas },
          );
          const report = fake.controls.getProgressComment("## PR Agent Triage")?.body;
          if (scenario === "accepted") {
            expect(report).toContain(firstSha.slice(0, 7));
            expect(report).toContain(pushedHeadSha.slice(0, 7));
          } else {
            expect(report).toContain("closed or merged");
            expect(report).not.toContain("Pushed commits:");
            expect(
              fake.controls.events.filter(
                (event) => event.kind === "replyAt" || event.kind === "resolveInlineReviewThread",
              ),
            ).toHaveLength(0);
          }
        } else {
          await expect(recovery()).rejects.toMatchObject({
            code:
              scenario === "cancel during evidence"
                ? "triage.cancelled"
                : scenario === "observation outage"
                  ? "operation_intent.recovery_failed"
                  : "operation_intent.mutation_outcome_unknown",
          });
          expect(
            await createPublishContext(pool, {
              workItemId,
              resourceKey,
              reviewLens: "triage",
            }).completed("triage_push"),
          ).toBeNull();
          expect(
            fake.controls.events.filter(
              (event) =>
                event.kind === "upsertProgressComment" ||
                event.kind === "replyAt" ||
                event.kind === "resolveInlineReviewThread",
            ),
          ).toHaveLength(0);
          if (scenario !== "observation outage" && scenario !== "cancel during evidence") {
            const intent = await intentRepository.getOperationIntent(
              pool,
              workItemId,
              operationKey,
            );
            expect(intent).toMatchObject({
              status: "outcome_unknown",
              detail: { unknownResolution: "terminal" },
            });
            await expect(recovery()).rejects.toMatchObject({
              code: "operation_intent.mutation_outcome_unknown",
            });
          }
        }
        expect(gitAuth).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each(["cancel before push", "cancel during push", "lease lost during push"] as const)(
    "blocks feature publication across %s",
    async (scenario) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/triage-cancel-${randomUUID()}#1`;
      const headSha = "a".repeat(40);
      const commitSha = "b".repeat(40);
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'triage', 'slash', 'running', 'o', 'r', 1, 42, $3, NULL, $2, '{}')`,
        [workItemId, resourceKey, headSha],
      );
      await acquirePrActorLease(pool, {
        resourceKey,
        workType: "triage",
        workItemId,
        holderId: "m8-test",
        ttlSeconds: 120,
      });
      const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }, { headSha });
      const push = vi.fn(async () => {
        if (scenario === "cancel during push")
          await pool.query(
            "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
            [workItemId],
          );
        if (scenario === "lease lost during push")
          await pool.query(
            "UPDATE pr_actor_leases SET holder_id = NULL, work_item_id = NULL WHERE resource_key = $1",
            [resourceKey],
          );
      });
      try {
        if (scenario === "cancel before push")
          await pool.query(
            "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
            [workItemId],
          );
        await expect(
          publishTriage({
            pool,
            workItemId,
            resourceKey,
            installationId: 42,
            prSurface: fake.surface,
            owner: "o",
            repo: "r",
            prNumber: 1,
            headSha,
            checkout: {
              headRef: "branch",
              push,
              listCommittedShas: () => [commitSha],
              listCommittedDetails: () => [
                { sha: commitSha, subject: "fix: issue", diff: "+fixed\n" },
              ],
            },
            inventory: [
              {
                rootCommentId: 1,
                lens: "review",
                path: "src/app.ts",
                line: 1,
                severity: "P1",
                titleSnippet: "Bug",
                humanReplies: [],
                threadUrl: "https://github.test/thread",
              },
            ],
            resolutionByRootCommentId: new Map(),
            payload: {
              verdicts: [
                { verdict: "fixed", threadRootCommentId: 1, commitSha, evidence: "fixed" },
              ],
            },
            previouslyResolvedCount: 0,
            leaseEpoch: 1,
          }),
        ).rejects.toMatchObject({
          code:
            scenario === "lease lost during push"
              ? "agent_work.pr_actor_lease_lost"
              : "triage.cancelled",
        });
        expect(push).toHaveBeenCalledTimes(scenario === "cancel before push" ? 0 : 1);
        expect(
          await createPublishContext(pool, {
            workItemId,
            resourceKey,
            reviewLens: "triage",
          }).completed("triage_push"),
        ).toBeNull();
        expect(
          fake.controls.events.filter(
            (event) =>
              event.kind === "upsertProgressComment" ||
              event.kind === "replyAt" ||
              event.kind === "resolveInlineReviewThread",
          ),
        ).toHaveLength(0);
      } finally {
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it("refuses to label a regenerated checkout pushed from another plan's stashed result", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/triage-cached-plan-${randomUUID()}#1`;
    const headSha = "a".repeat(40);
    const selectedSha = "b".repeat(40);
    const acceptedSha = "c".repeat(40);
    const operationKey = triagePushOperationKey(resourceKey);
    const fake = createFakePrSurface(
      { owner: "o", repo: "r", prNumber: 1 },
      { headSha: acceptedSha },
    );
    const push = vi.fn(async () => undefined);
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'triage', 'slash', 'running', 'o', 'r', 1, 42, $3, NULL, $2, '{}')`,
      [workItemId, resourceKey, headSha],
    );
    try {
      await intentRepository.persistOperationIntent(pool, {
        workItemId,
        operationKey,
        mutationKind: "github.triage_push",
        detail: {
          pushPlan: {
            pushOutcome: "pushed",
            baseHeadSha: headSha,
            headRef: "branch",
            pushedHeadSha: acceptedSha,
            pushedShas: [acceptedSha],
            commits: [{ sha: acceptedSha, subject: "fix: accepted", diff: "+old\n" }],
            payload: {
              verdicts: [
                {
                  verdict: "fixed",
                  threadRootCommentId: 1,
                  commitSha: acceptedSha,
                  evidence: "old",
                },
              ],
            },
            threadRootCommentIds: [1],
          },
        },
      });
      await intentRepository.reconcileOperationIntent(pool, {
        workItemId,
        operationKey,
        status: "reconciled",
        detail: { __result: null },
      });
      await expect(
        publishTriage({
          pool,
          workItemId,
          resourceKey,
          installationId: 42,
          prSurface: fake.surface,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha,
          checkout: {
            headRef: "branch",
            push,
            listCommittedShas: () => [selectedSha],
            listCommittedDetails: () => [{ sha: selectedSha, subject: "fix: new", diff: "+new\n" }],
          },
          inventory: [
            {
              rootCommentId: 1,
              lens: "review",
              path: "src/app.ts",
              line: 1,
              severity: "P1",
              titleSnippet: "Bug",
              humanReplies: [],
              threadUrl: "https://github.test/thread",
            },
          ],
          resolutionByRootCommentId: new Map(),
          payload: {
            verdicts: [
              { verdict: "fixed", threadRootCommentId: 1, commitSha: selectedSha, evidence: "new" },
            ],
          },
          previouslyResolvedCount: 0,
          leaseEpoch: null,
        }),
      ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
      expect(push).not.toHaveBeenCalled();
      expect(
        await createPublishContext(pool, {
          workItemId,
          resourceKey,
          reviewLens: "triage",
        }).completed("triage_push"),
      ).toBeNull();
      expect(fake.controls.getProgressComment("## PR Agent Triage")).toBeNull();
    } finally {
      await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it("retains the selected retry plan before delegation and recovers it without another push", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/triage-rearmed-${randomUUID()}#1`;
    const headSha = "a".repeat(40);
    const commitSha = "b".repeat(40);
    const operationKey = triagePushOperationKey(resourceKey);
    const payload = {
      verdicts: [
        { verdict: "fixed" as const, threadRootCommentId: 1, commitSha, evidence: "fixed" },
      ],
    };
    const commits = [{ sha: commitSha, subject: "fix: selected retry", diff: "+fixed\n" }];
    const inventory = [
      {
        rootCommentId: 1,
        lens: "review" as const,
        path: "src/app.ts",
        line: 1,
        severity: "P1" as const,
        titleSnippet: "Bug",
        humanReplies: [],
        threadUrl: "https://github.test/thread",
      },
    ];
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }, { headSha });
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'triage', 'slash', 'running', 'o', 'r', 1, 42, $3, NULL, $2, '{}')`,
      [workItemId, resourceKey, headSha],
    );
    let delegated: intentRepository.OperationIntentRow | null = null;
    const push = vi.fn(async () => {
      delegated = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
      throw new Error("Provider connection interrupted");
    });
    try {
      await intentRepository.persistOperationIntent(pool, {
        workItemId,
        operationKey,
        mutationKind: "github.triage_push",
        detail: { pushPlan: { pushedHeadSha: "c".repeat(40) }, __mutating: false },
      });
      await expect(
        publishTriage({
          pool,
          workItemId,
          resourceKey,
          installationId: 42,
          prSurface: fake.surface,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha,
          checkout: {
            headRef: "branch",
            push,
            listCommittedShas: () => [commitSha],
            listCommittedDetails: () => commits,
          },
          inventory,
          resolutionByRootCommentId: new Map(),
          payload,
          previouslyResolvedCount: 0,
          leaseEpoch: null,
        }),
      ).rejects.toThrow("Provider connection interrupted");
      expect(delegated).toMatchObject({
        detail: {
          __mutating: true,
          pushPlan: {
            baseHeadSha: headSha,
            headRef: "branch",
            pushedHeadSha: commitSha,
            pushedShas: [commitSha],
            commits,
            payload,
            threadRootCommentIds: [1],
          },
        },
      });
      fake.controls.setHeadSha(commitSha);
      fake.controls.setPushedCommits(commits);
      expect(
        await recoverTriagePublication({
          pool,
          workItemId,
          resourceKey,
          installationId: 42,
          prSurface: fake.surface,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: commitSha,
          headRef: "branch",
          inventory,
          resolutionByRootCommentId: new Map(),
          previouslyResolvedCount: 0,
          leaseEpoch: null,
        }),
      ).toMatchObject({ pushOutcome: "pushed" });
      expect(push).toHaveBeenCalledTimes(1);
      expect(fake.controls.getProgressComment("## PR Agent Triage")?.body).toContain(
        commitSha.slice(0, 7),
      );
    } finally {
      await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it.each(["head", "inventory", "partial", "branch"] as const)(
    "refuses mismatched retained triage evidence: %s",
    async (mismatch) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/triage-owner-${randomUUID()}#1`;
      const headSha = "b".repeat(40);
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'triage', 'slash', 'running', 'o', 'r', 1, 42, $3, NULL, $2, '{}')`,
        [workItemId, resourceKey, headSha],
      );
      const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
      try {
        await createPublishContext(pool, {
          workItemId,
          resourceKey,
          reviewLens: "triage",
          leaseEpoch: null,
        }).record({
          step: "triage_push",
          detail: {
            pushOutcome: "pushed",
            baseHeadSha: "a".repeat(40),
            headRef: mismatch === "branch" ? "another-branch" : "main",
            pushedHeadSha: mismatch === "head" ? "c".repeat(40) : headSha,
            pushedShas: mismatch === "partial" ? [] : [headSha],
            commits: [{ sha: headSha, subject: "fix: issue", diff: "+fixed\n" }],
            payload: {
              verdicts: [
                {
                  verdict: "fixed",
                  threadRootCommentId: 1,
                  commitSha: headSha,
                  evidence: "fixed",
                },
              ],
            },
          },
        });
        expect(
          await recoverTriagePublication({
            pool,
            workItemId,
            resourceKey,
            installationId: 42,
            prSurface: fake.surface,
            owner: "o",
            repo: "r",
            prNumber: 1,
            headSha,
            headRef: "main",
            inventory:
              mismatch === "inventory"
                ? []
                : [
                    {
                      rootCommentId: 1,
                      lens: "review",
                      path: "src/app.ts",
                      line: 1,
                      severity: "P1",
                      titleSnippet: "Bug",
                      humanReplies: [],
                      threadUrl: "https://github.test/thread",
                    },
                  ],
            resolutionByRootCommentId: new Map(),
            previouslyResolvedCount: 0,
            leaseEpoch: null,
          }),
        ).toBeNull();
        expect(fake.controls.events).toHaveLength(0);
      } finally {
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it("keeps the golden operation, marker, queue, and telemetry wire identities", () => {
    const resourceKey = prResourceKey("golden", "repo", 7);
    const batchId = deterministicInlineBatchId({
      workItemId: "golden-work",
      specialist: "correctness",
      findingFingerprints: ["fp-b", "fp-a"],
    });
    const keys = [
      askReplyOperationKey(resourceKey),
      askReplyOperationKey(resourceKey, 70),
      askFailureReplyOperationKey(resourceKey),
      askFailureReplyOperationKey(resourceKey, 70),
      descriptionPrBodyOperationKey(resourceKey),
      reviewInlineBatchOperationKey(batchId),
      reviewSummaryOperationKey(resourceKey, "review"),
      triagePushOperationKey(resourceKey),
      triageThreadOperationKey(70),
      triageReportOperationKey(resourceKey),
      triagePreviewOperationKey(resourceKey),
      verificationThreadOperationKey(70),
      verificationFailureOperationKey("abc1234"),
      reviewCheckOperationKey("golden-work"),
      ownVerdictCloseOperationKey({
        workItemId: "golden-work",
        resourceKey,
        reviewLens: "review",
      }),
      ...(["pending", "success", "failure", "error"] as const).map((state) =>
        reviewCommitStatusOperationKey(resourceKey, "abc1234", state),
      ),
      reviewLabelsOperationKey(resourceKey),
    ];
    expect(keys).toEqual([
      "ask:reply:golden/repo#7",
      "ask:reply:golden/repo#7:70",
      "ask:failure_reply:golden/repo#7",
      "ask:failure_reply:golden/repo#7:70",
      "description:pr_body:golden/repo#7",
      "review:inline:ac9015646ef60021fd1f416ef9f5c0b4",
      "review:summary:review:golden/repo#7",
      "triage:push:golden/repo#7",
      "triage:thread:70",
      "triage:report:golden/repo#7",
      "triage:preview:golden/repo#7",
      "verification:thread:70",
      "verification:failure:abc1234",
      "review:check_run:golden-work",
      "review:check_run_close:golden-work:review",
      "review:commit_status:golden/repo#7:abc1234:pending",
      "review:commit_status:golden/repo#7:abc1234:success",
      "review:commit_status:golden/repo#7:abc1234:failure",
      "review:commit_status:golden/repo#7:abc1234:error",
      "review:labels:golden/repo#7",
    ]);
    expect([
      operationIntentMarker("review:summary:review:golden/repo#7", "golden-work"),
      withProgressRevisionComment("Golden progress", 7, "golden/work"),
      withProgressRevisionComment("Legacy progress", 7),
      renderStaleReviewMetadataComment({ headSha: "abc1234", mode: "review", stale: false }),
      renderReviewPointerLensMarker("review-security"),
      renderCiRollupMarker("abc1234", 3, "passing"),
      renderCiActionPhrase("CI is passing"),
      renderCiSummaryCell(
        { status: "passing", headline: "CI is passing", failures: [] },
        "abc1234",
        3,
      ),
      wrapDescriptionAgentBlock("Golden description"),
      renderClearedVerificationFailureStub(),
    ]).toEqual([
      "<!-- pr-agent:operation-intent dccbbf3d94b8df60ea6d339e -->",
      "Golden progress\n<!-- pr-agent:progress-revision workItemId=golden%2Fwork value=7 -->",
      "Legacy progress\n<!-- pr-agent:progress-revision 7 -->",
      "<!-- pr-agent:review-meta headSha=abc1234 lens=review stale=false -->",
      "<!-- pr-agent:review-pointer lens=review-security -->",
      "<!-- pr-agent:ci-rollup head=abc1234 v=3 -->passing<!-- /pr-agent:ci-rollup -->",
      "<!-- pr-agent:ci-action fmt=1 -->CI is passing<!-- /pr-agent:ci-action -->",
      "<!-- pr-agent:ci-summary head=abc1234 v=3 fmt=1 -->CI is passing<!-- /pr-agent:ci-summary -->",
      "<!-- PR_AGENT_DESCRIPTION_BEGIN -->\nGolden description\n<!-- PR_AGENT_DESCRIPTION_END -->",
      "<!-- pr-agent:verification-failure --><!-- /pr-agent:verification-failure -->",
    ]);
    expect([...WORKER_CONSUMER_QUEUES].toSorted()).toEqual([
      "agent-work-ack",
      "agent-work-ask",
      "agent-work-ci-projection",
      "agent-work-description",
      "agent-work-retention",
      "agent-work-review",
      "agent-work-triage",
      "agent-work-verification",
      "code-index-build",
    ]);
    expect([...WORKER_DLQ_QUEUES].toSorted()).toEqual([
      "agent-work-ack-dead",
      "agent-work-ask-dead",
      "agent-work-ci-projection-dead",
      "agent-work-description-dead",
      "agent-work-review-dead",
      "agent-work-triage-dead",
      "agent-work-verification-dead",
    ]);
    const capture = vi.spyOn(analytics, "captureEvent").mockImplementation(() => {});
    const item = {
      id: "golden-work",
      installationId: 42,
      owner: "golden",
      repo: "repo",
      prNumber: 7,
      headSha: "abc1234",
    };
    recordWorkCompleted({
      item,
      workType: "review",
      durationMs: 120,
      attemptCount: 1,
      completion: {
        kind: "review-profile",
        outcome: "published",
        durationMs: 120,
        attemptCount: 1,
        publish: { publishAttempts: 0, publishStepCount: 5 },
        reviewLens: "review",
        source: "slash",
        findingsCount: 2,
      },
      ci: { rollup: "passing", failingCount: 0, authored: false },
    });
    captureWebhookReceived({
      githubEvent: "pull_request",
      delivery: "golden-delivery",
      elapsedMs: 10,
      outcome: "accepted",
      reason: "automated_review_enqueued",
    });
    captureWorkRetried({
      workItemId: item.id,
      ...item,
      workType: "review",
      attemptCount: 1,
      nextAttempt: 2,
      retryDisposition: "transient",
      escalationKinds: ["tool_rounds"],
      failure: { failureDomain: "github", errorKind: "rate_limit" },
    });
    captureCiStateChanged({
      ...item,
      fromRollup: "pending",
      toRollup: "passing",
      version: 3,
    });
    expect(capture.mock.calls.map(([event]) => event)).toEqual([
      {
        distinctId: "installation:42",
        event: "work completed",
        properties: {
          work_item_id: "golden-work",
          work_type: "review",
          outcome: "published",
          reason: "published",
          duration_ms: 120,
          attempt_count: 1,
          owner: "golden",
          repo: "repo",
          pr_number: 7,
          head_sha: "abc1234",
          publish_attempts: 0,
          publish_step_count: 5,
          review_lens: "review",
          source: "slash",
          findings_count: 2,
          ci_rollup: "passing",
          ci_failing_count: 0,
          ci_authored: false,
        },
      },
      {
        distinctId: "server",
        event: "webhook received",
        properties: {
          github_event: "pull_request",
          delivery: "golden-delivery",
          elapsed_ms: 10,
          outcome: "accepted",
          reason: "automated_review_enqueued",
        },
      },
      {
        distinctId: "installation:42",
        event: "work item retried",
        properties: {
          work_item_id: "golden-work",
          work_type: "review",
          owner: "golden",
          repo: "repo",
          pr_number: 7,
          head_sha: "abc1234",
          attempt_count: 1,
          next_attempt: 2,
          retry_disposition: "transient",
          escalation_kinds: ["tool_rounds"],
          failure_domain: "github",
          error_kind: "rate_limit",
        },
      },
      {
        distinctId: "installation:42",
        event: "ci state changed",
        properties: {
          owner: "golden",
          repo: "repo",
          head_sha: "abc1234",
          from_rollup: "pending",
          to_rollup: "passing",
          version: 3,
        },
      },
    ]);
  });

  it.each([
    ["reconciled", true],
    ["pending", true],
    ["outcome_unknown", true],
    ["failed", true],
    ["reconciled", false],
    ["pending", false],
    ["outcome_unknown", false],
    ["failed", false],
  ] as const)(
    "reuses the retained non-default description child in %s (parent frame: %s)",
    async (status, framed) => {
      const workItemId = randomUUID();
      const parent = framed ? "golden:historical-description" : undefined;
      const marker = "golden-historical-marker";
      // Precomputed from the legacy full fake Config, including the removed values.
      const hash = "50066c7921debb1bef12c704a6c3d26fc43acbd7d647bcb52877a0847fbf08d7";
      const key =
        parent == null
          ? `pr-surface:publishDescription:${hash}`
          : `${parent}:surface:publishDescription:${hash}`;
      const update = { title: "Golden title", body: "Golden description" };
      const result = { prNumber: 7, bodyUpdated: true };
      const detail = {
        surfaceMethod: "publishDescription",
        inputHash: hash,
        ...(parent == null ? {} : { parentOperationKey: parent }),
        operationMarker: marker,
        __mutating: true,
        ...(status === "reconciled" ? { __result: result } : {}),
        ...(status === "failed" ? { errorCode: "operation_intent.mutation_failed" } : {}),
      };
      await pool.query(
        `INSERT INTO agent_work_items (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, resource_key)
      VALUES ($1, 'description', 'slash', 'running', 'golden', 'repo', 7, 42, 'abc1234', $2)`,
        [workItemId, `golden/${workItemId}#7`],
      );
      try {
        await pool.query(
          `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
        VALUES ($1, $2, $3, 'github.pr_surface.publishDescription', $4, $5::jsonb)`,
          [randomUUID(), workItemId, key, status, JSON.stringify(detail)],
        );
        // Same method/marker in a different parent scope must remain untouched.
        const otherKey = `other:surface:publishDescription:${hash}`;
        await pool.query(
          `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
        VALUES ($1, $2, $3, 'github.pr_surface.publishDescription', 'pending', $4::jsonb)`,
          [
            randomUUID(),
            workItemId,
            otherKey,
            JSON.stringify({ ...detail, parentOperationKey: "other", __result: null }),
          ],
        );
        const otherMarkerHash = "a".repeat(64);
        const otherMarkerKey =
          parent == null
            ? `pr-surface:publishDescription:${otherMarkerHash}`
            : `${parent}:surface:publishDescription:${otherMarkerHash}`;
        await pool.query(
          `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
           VALUES ($1, $2, $3, 'github.pr_surface.publishDescription', 'pending', $4::jsonb)`,
          [
            randomUUID(),
            workItemId,
            otherMarkerKey,
            JSON.stringify({
              ...detail,
              inputHash: otherMarkerHash,
              operationMarker: "another-description-marker",
            }),
          ],
        );
        const before = (
          await pool.query(
            "SELECT * FROM operation_intents WHERE work_item_id=$1 AND operation_key IN ($2,$3) ORDER BY operation_key",
            [workItemId, otherKey, otherMarkerKey],
          )
        ).rows;
        const { surface, controls } = createFakePrSurface(
          { owner: "golden", repo: "repo", prNumber: 7 },
          {
            mutationBoundary: {
              signal: new AbortController().signal,
              run: <T>(mutation: PrSurfaceMutation, mutate: () => Promise<T>) =>
                publishOnce<T>({
                  client: pool,
                  workItemId,
                  operationKey: mutation.operationKey,
                  mutationKind: mutation.mutationKind,
                  detail: mutation.detail,
                  recover: (intent) => recoverPrSurfaceMutation<T>(surface, intent),
                  mutate,
                }),
            },
          },
        );
        const replay = () =>
          parent == null
            ? surface.updatePullRequest(update, marker)
            : runInOperationIntentFrame(parent, () => surface.updatePullRequest(update, marker));
        if (status === "pending" || status === "outcome_unknown") {
          await expect(replay()).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          await expect(replay()).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
        } else {
          await expect(replay()).resolves.toMatchObject({ prNumber: 7 });
          await expect(replay()).resolves.toMatchObject({ prNumber: 7 });
        }
        expect(controls.events.filter((event) => event.kind === "updatePullRequest")).toHaveLength(
          status === "failed" ? 1 : 0,
        );
        const rows = (
          await pool.query(
            "SELECT operation_key, status, detail FROM operation_intents WHERE work_item_id=$1 AND operation_key NOT IN ($2,$3)",
            [workItemId, otherKey, otherMarkerKey],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          operation_key: key,
          status:
            status === "pending" || status === "outcome_unknown" ? "outcome_unknown" : "reconciled",
          detail: { inputHash: hash, surfaceMethod: "publishDescription", operationMarker: marker },
        });
        expect(
          (
            await pool.query(
              "SELECT * FROM operation_intents WHERE work_item_id=$1 AND operation_key IN ($2,$3) ORDER BY operation_key",
              [workItemId, otherKey, otherMarkerKey],
            )
          ).rows,
        ).toEqual(before);
      } finally {
        await pool.query("DELETE FROM agent_work_items WHERE id=$1", [workItemId]);
      }
    },
  );

  it.each(["ambiguous", "malformed", "missing-marker"])(
    "refuses %s retained description identity without touching rows",
    async (mode) => {
      const workItemId = randomUUID();
      const parent = "golden:historical-description";
      const marker = mode === "missing-marker" ? undefined : "golden-historical-marker";
      const hash = "50066c7921debb1bef12c704a6c3d26fc43acbd7d647bcb52877a0847fbf08d7";
      await pool.query(
        `INSERT INTO agent_work_items (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, resource_key)
      VALUES ($1, 'description', 'slash', 'running', 'golden', 'repo', 7, 42, 'abc1234', $2)`,
        [workItemId, `golden/${workItemId}#7`],
      );
      try {
        for (const identity of mode === "ambiguous" ? [hash, "a".repeat(64)] : [hash]) {
          await pool.query(
            `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
          VALUES ($1, $2, $3, 'github.pr_surface.publishDescription', 'pending', $4::jsonb)`,
            [
              randomUUID(),
              workItemId,
              `${parent}:surface:publishDescription:${identity}`,
              JSON.stringify({
                surfaceMethod: "publishDescription",
                parentOperationKey: parent,
                inputHash: mode === "malformed" ? "wrong" : identity,
                ...(marker == null ? {} : { operationMarker: marker }),
                __mutating: true,
              }),
            ],
          );
        }
        const before = (
          await pool.query(
            "SELECT * FROM operation_intents WHERE work_item_id=$1 ORDER BY operation_key",
            [workItemId],
          )
        ).rows;
        const { surface, controls } = createFakePrSurface(
          { owner: "golden", repo: "repo", prNumber: 7 },
          {
            mutationBoundary: {
              signal: new AbortController().signal,
              run: <T>(mutation: PrSurfaceMutation, mutate: () => Promise<T>) =>
                publishOnce<T>({
                  client: pool,
                  workItemId,
                  operationKey: mutation.operationKey,
                  mutationKind: mutation.mutationKind,
                  detail: mutation.detail,
                  recover: (intent) => recoverPrSurfaceMutation<T>(surface, intent),
                  mutate,
                }),
            },
          },
        );
        await expect(
          runInOperationIntentFrame(parent, () =>
            surface.updatePullRequest(
              { title: "Golden title", body: "Golden description" },
              marker,
            ),
          ),
        ).rejects.toMatchObject({ code: "operation_intent.description_identity_conflict" });
        expect(controls.events.filter((event) => event.kind === "updatePullRequest")).toHaveLength(
          0,
        );
        expect(
          (
            await pool.query(
              "SELECT * FROM operation_intents WHERE work_item_id=$1 ORDER BY operation_key",
              [workItemId],
            )
          ).rows,
        ).toEqual(before);
      } finally {
        await pool.query("DELETE FROM agent_work_items WHERE id=$1", [workItemId]);
      }
    },
  );

  it("persists golden child mutation identities and publish steps, then replays quietly", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/golden-${randomUUID()}#7`;
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'golden', 'repo', 7, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
      [workItemId, resourceKey],
    );
    try {
      const { surface, controls } = createFakePrSurface(
        { owner: "golden", repo: "repo", prNumber: 7 },
        {
          mutationBoundary: {
            signal: new AbortController().signal,
            run: (mutation, mutate) =>
              publishOnce({
                client: pool,
                workItemId,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                allowsUndefinedResult: mutation.allowsUndefinedResult,
                mutate,
              }),
          },
        },
      );
      const publish = () =>
        runInOperationIntentFrame("golden:publish", async () => {
          await surface.setAcknowledgementReaction([{ kind: "pr", prNumber: 7 }], "eyes");
          await surface.replyAt({ kind: "prConversation", prNumber: 7 }, "Golden reply");
          await surface.upsertProgressComment("Golden progress", "## PR Agent Review", null);
          await surface.editComment(70, "Golden edit");
          await surface.setReviewCommitStatus("abc1234", {
            state: "pending",
            description: "Golden status",
          });
          await surface.publishThreadBatch({
            body: "Golden batch",
            event: "COMMENT",
            commitId: "abc1234",
          });
          await surface.resolveInlineReviewThread("thread-70");
          await surface.setLabels(["size:S"]);
          await surface.startReviewCheck("abc1234", "golden-work", "Golden check");
          await surface.finishReviewCheck({
            checkRunId: 70,
            conclusion: "success",
            summary: "Golden finish",
          });
          await surface.editReviewComment(70, "Golden inline edit");
          await surface.updatePullRequest(
            { title: "Golden title", body: "Golden description" },
            "golden-marker",
          );
        });
      await publish();
      const goldenMutations = [
        [
          "setAcknowledgementReaction",
          "4d09ac889232a31e821f810464fb52a090a0a1e05d301a6d2fe33b073dc6db3b",
        ],
        ["replyAt", "c0a257e85c86d90e91517cb171256feba89495bdf513c8847cf82a5a893cfd13"],
        [
          "upsertProgressComment",
          "082b4f927fc7fd1166d470f47d6b22c421085d670fa7e9738efa20c80b9abcde",
        ],
        ["editComment", "332bd21bd9b63060867ed2f14abba7b0153128d29efe17fa4c1fe6212172bdbc"],
        [
          "setReviewCommitStatus",
          "a7256e87080221c1ae6ea8aa8af01729e2a67e5b3ae40ac01fa46073691a822e",
        ],
        ["publishThreadBatch", "1624f184ccd4ad89fb30f0afd9e5ea3dfc2da5ca3c890f937de783f1f510a741"],
        [
          "resolveInlineReviewThread",
          "6644b643cb21bbc999250057a3622cf81f0f1051a8c87dd1723abef1d05f3c5e",
        ],
        ["setLabels", "1fc69e3d719739df4222b34dd74e8409741a8a9fd61f7c64c7906eefb5d4cbd6"],
        ["startReviewCheck", "cfcc743c2af2b8d92ddc6236b2f8fdc06d1d86b28ed469ea2674f085ade619c2"],
        ["finishReviewCheck", "843928f34a07ccf776768e11f5f7d20ea6a94eaa9fb6db0b505f92e90a0cbb3f"],
        ["editReviewComment", "b2e5dded37008c066689bb3a605ba1576271ea11ea15cdac0b736d7d2907f90e"],
        ["publishDescription", "4e5225fc7e449cdf82f2658758e5890a83f86ce5b6aa6a8e85479d492c437f0c"],
      ] as const;
      const intents = await pool.query(
        `SELECT operation_key, mutation_kind, status,
                detail->>'parentOperationKey' AS parent, detail->>'inputHash' AS hash
           FROM operation_intents WHERE work_item_id = $1 ORDER BY mutation_kind`,
        [workItemId],
      );
      expect(intents.rows).toEqual(
        goldenMutations
          .map(([method, hash]) => ({
            operation_key: `golden:publish:surface:${method}:${hash}`,
            mutation_kind: `github.pr_surface.${method}`,
            status: "reconciled",
            parent: "golden:publish",
            hash,
          }))
          .toSorted((left, right) => left.mutation_kind.localeCompare(right.mutation_kind)),
      );
      const effects = controls.events.length;
      await publish();
      expect(controls.events).toHaveLength(effects);
      expect(controls.replies).toHaveLength(1);
      expect(controls.threadBatches).toHaveLength(1);

      const steps = [
        ["review", "progress_comment"],
        ["review", "inline_review"],
        ["review", "summary_comment"],
        ["review", "labels"],
        ["description", "pr_body"],
        ["triage", "triage_push"],
        ["triage", "triage_thread_actions"],
        ["triage", "triage_report"],
        ["triage", "triage_preview"],
        ["review", "ci_cell"],
        ["review", "commit_status"],
        ["verification", "verification_failure"],
      ] as const satisfies readonly (readonly [string, PublishStep])[];
      for (const [reviewLens, step] of steps) {
        await createPublishContext(pool, {
          workItemId,
          resourceKey,
          reviewLens,
          step,
          leaseEpoch: null,
          githubId: 70,
          detail: { golden: true },
        }).record();
      }
      await claimSummaryCommentCreation(pool, workItemId, resourceKey, "review", null);
      await recordReviewCheckRun(pool, {
        workItemId,
        resourceKey,
        reviewLens: "review",
        githubId: 70,
        leaseEpoch: null,
      });
      await createPublishContext(pool, {
        workItemId,
        resourceKey,
        step: "ask_reply",
        githubId: 70,
        leaseEpoch: null,
        reviewLens: "ask",
      }).record();
      await saveVerificationThreadLedger(pool, {
        workItemId,
        resourceKey,
        ledger: { threads: { "70": { lastVerdict: "fixed", terminal: true } } },
        leaseEpoch: null,
      });
      const records = await pool.query(
        "SELECT review_lens, step, status FROM publish_records WHERE work_item_id = $1 ORDER BY review_lens, step",
        [workItemId],
      );
      expect(records.rows).toEqual(
        [
          ["ask", "ask_reply"],
          ["description", "pr_body"],
          ["review", "check_run"],
          ["review", "ci_cell"],
          ["review", "commit_status"],
          ["review", "inline_review"],
          ["review", "labels"],
          ["review", "progress_comment"],
          ["review", "summary_comment"],
          ["review", "summary_comment_claim"],
          ["triage", "triage_preview"],
          ["triage", "triage_push"],
          ["triage", "triage_report"],
          ["triage", "triage_thread_actions"],
          ["verification", "verification_failure"],
          ["verification", "verification_thread_actions"],
        ].map(([review_lens, step]) => ({ review_lens, step, status: "completed" })),
      );
    } finally {
      await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it("publishes distinct nested batches and records each once across retries", async () => {
    const workItemId = randomUUID();
    const resourceKey = `integration/publish-batches#${randomUUID()}`;
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, $3::jsonb)`,
      [workItemId, resourceKey, JSON.stringify({ mode: "review", source: "slash" })],
    );

    try {
      const { surface, controls } = createFakePrSurface(
        { owner: "o", repo: "r", prNumber: 1 },
        {
          mutationBoundary: {
            signal: new AbortController().signal,
            run: (mutation, mutate) =>
              publishOnce({
                client: pool,
                workItemId,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                recover: mutation.recover as PublishOnceParams<
                  Awaited<ReturnType<typeof mutate>>
                >["recover"],
                allowsUndefinedResult: mutation.allowsUndefinedResult,
                mutate,
              }),
          },
        },
      );
      const publish = (body: string) =>
        runInOperationIntentFrame("review:publish", () =>
          surface.publishThreadBatch({ body, event: "COMMENT", commitId: "abc1234" }),
        );
      const first = await publish("correctness findings");
      const second = await publish("security findings");
      expect(await publish("correctness findings")).toEqual(first);
      expect(await publish("security findings")).toEqual(second);
      expect(first.reviewId).not.toBe(second.reviewId);
      expect(controls.threadBatches.map((batch) => batch.body)).toEqual([
        "correctness findings",
        "security findings",
      ]);
      const intents = await pool.query<{ operation_key: string; status: string }>(
        "SELECT operation_key, status FROM operation_intents WHERE work_item_id = $1",
        [workItemId],
      );
      expect(intents.rows).toHaveLength(2);
      expect(new Set(intents.rows.map((intent) => intent.operation_key)).size).toBe(2);
      expect(intents.rows.map((intent) => intent.status)).toEqual(["reconciled", "reconciled"]);

      const firstBatch = {
        batchId: "batch-1",
        workItemId,
        specialist: "correctness",
        reviewId: first.reviewId,
        fingerprints: ["fp-1"],
        placements: [
          {
            finding: {
              severity: "P1",
              file: "src/a.ts",
              startLine: 10,
              endLine: 10,
              title: "Missing null check",
              detail: "The payload can be null.",
              fixPrompt: "Guard the payload before dereferencing it.",
            },
            resolvedLine: 10,
            canonicalFingerprint: "fp-1",
          },
        ],
      };
      const secondBatch = {
        batchId: "batch-2",
        workItemId,
        specialist: "security",
        reviewId: second.reviewId,
        fingerprints: ["fp-2"],
        placements: [],
      };
      const write = (detail: typeof firstBatch) =>
        createPublishContext(pool, {
          workItemId,
          leaseEpoch: null,
          resourceKey,
          reviewLens: "review",
          step: "inline_review",
          githubId: detail.reviewId,
          detail,
        }).record();

      await write(firstBatch);
      await write(firstBatch);
      await write(secondBatch);
      await createPublishContext(pool, {
        workItemId,
        leaseEpoch: null,
        resourceKey,
        reviewLens: "review-security",
        step: "inline_review",
        githubId: 40,
        detail: { fingerprints: ["fp-legacy"] },
      }).record();

      const result = await pool.query<{ github_id: string; detail: { batches: unknown[] } }>(
        `SELECT github_id, detail
           FROM publish_records
          WHERE resource_key = $1
            AND review_lens = 'review'
            AND step = 'inline_review'`,
        [resourceKey],
      );
      expect(result.rows).toEqual([
        {
          github_id: String(second.reviewId),
          detail: { batches: [firstBatch, secondBatch] },
        },
      ]);
      const context = await loadReviewExecutorPublishContext(
        pool,
        workItemId,
        resourceKey,
        "review",
      );
      expect(context.publishState.inlineReviewIds).toEqual([first.reviewId, second.reviewId]);
      expect(context.publishState.threadCallCount).toBe(2);
      expect(context.storedInlineFingerprints.toSorted()).toEqual(["fp-1", "fp-2", "fp-legacy"]);
      expect(context.resumedPlacements).toEqual([
        {
          kind: "resumed",
          source: "correctness",
          placement: {
            finding: firstBatch.placements[0]?.finding,
            inlineLine: 10,
            inlinePosted: true,
          },
          canonicalFingerprint: "fp-1",
          reviewId: first.reviewId,
        },
      ]);
    } finally {
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it.each([true, false])(
    "retries an incomplete check lookup without remutation, observed match: %s",
    async (matched) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/check-lookup-${randomUUID()}#1`;
      const operationKey = "review:check-lookup";
      const token = `fake-check-lookup-${workItemId}`;
      const client = appAuth.installationOctokit(token);
      const originalList = client.rest.checks.listForRef;
      let incomplete = true;
      const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey],
      );
      try {
        await intentRepository.persistOperationIntent(pool, {
          workItemId,
          operationKey,
          mutationKind: "github.pr_surface.startReviewCheck",
          detail: {
            __mutating: true,
            surfaceMethod: "startReviewCheck",
            headSha: "abc1234",
            externalId: workItemId,
          },
        });
        const mutate = vi.fn(() => surface.startReviewCheck("abc1234", workItemId));
        const check = await mutate();
        const exact = {
          id: check.id,
          name: "PR Agent Review",
          head_sha: "abc1234",
          external_id: workItemId,
          html_url: check.url,
        };
        const rows = Array.from(
          { length: CHECK_RUNS_MAX_PAGES * CHECK_RUNS_PAGE_SIZE },
          (_, index) => ({
            ...exact,
            id: index + 100,
            external_id: `other-${index}`,
          }),
        );
        if (matched) rows[CHECK_RUNS_PAGE_SIZE] = exact;
        const list = vi.fn(async ({ page = 1 }: { page?: number }) => ({
          data: {
            check_runs: incomplete
              ? rows.slice((page - 1) * CHECK_RUNS_PAGE_SIZE, page * CHECK_RUNS_PAGE_SIZE)
              : [exact],
          },
        }));
        Object.assign(client.rest.checks, { listForRef: list });
        const recoverySurface = {
          ...surface,
          findReviewCheck: (headSha: string, externalId: string) =>
            findReviewCheckRunByName(token, "o", "r", headSha, "PR Agent Review", externalId),
        };
        const params = {
          client: pool,
          workItemId,
          operationKey,
          mutationKind: "github.pr_surface.startReviewCheck",
          mutate,
          recover: (intent: intentRepository.OperationIntentRow) =>
            recoverPrSurfaceMutation<typeof check>(recoverySurface, intent),
        };
        const failure = await publishOnce(params).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "operation_intent.recovery_failed",
          cause: { code: "github.review_check_lookup_incomplete" },
        });
        expect(retryDispositionFor(failure)).toBe("transient");
        const unknown = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
        expect(unknown?.detail.unknownResolution).toBeUndefined();
        expect(unknown?.detail.__result).toBeUndefined();
        expect(await getWorkItem(pool, workItemId)).toMatchObject({ status: "running" });
        expect(mutate).toHaveBeenCalledTimes(1);

        incomplete = false;
        expect(await publishOnce(params)).toEqual(check);
        await recordReviewCheckRun(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          githubId: check.id,
          detail: { headSha: "abc1234", externalId: workItemId },
        });
        await surface.finishReviewCheck({
          checkRunId: check.id,
          conclusion: "success",
          summary: "Recovered.",
        });
        const reads = list.mock.calls.length;
        const effects = controls.events.length;
        expect(await publishOnce(params)).toEqual(check);
        expect(list).toHaveBeenCalledTimes(reads);
        expect(controls.events).toHaveLength(effects);
        expect(mutate).toHaveBeenCalledTimes(1);
        expect(controls.events.filter((event) => event.kind === "startReviewCheck")).toHaveLength(
          1,
        );
        expect(controls.events).toContainEqual({
          kind: "finishReviewCheck",
          checkRunId: check.id,
          conclusion: "success",
        });
        expect(
          await intentRepository.getOperationIntent(pool, workItemId, operationKey),
        ).toMatchObject({
          status: "reconciled",
          detail: { __result: check },
        });
      } finally {
        Object.assign(client.rest.checks, { listForRef: originalList });
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each([
    "setAcknowledgementReaction",
    "setReviewCommitStatus",
    "setLabels",
    "finishReviewCheck",
    "replyAt",
    "handled stash error",
    "published summary",
  ] as const)(
    "resolves %s after landed mutation and missing stash, then replays quietly",
    async (method) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/unknown-${randomUUID()}#1`;
      const cfg = makeTestConfig();
      const info = vi.spyOn(evlog, "logInfo");
      const failureLog = vi.spyOn(evlog, "logError");
      const boss = new PgBoss({ connectionString: cfg.runtime.databaseUrl });
      vi.spyOn(boss, "send").mockResolvedValue(randomUUID());
      vi.spyOn(boss, "findJobs").mockResolvedValue([]);
      vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
        type: "token",
        tokenType: "installation",
        token: "fake-integration-token",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        installationId: 42,
        permissions: {},
        repositorySelection: "all",
      });
      vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
        userId: 999,
        login: "pr-agent[bot]",
      });
      const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
      controls.setHeadSha("abc1234");
      controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "Review in progress", 70);
      vi.spyOn(surfaceFactory, "createPrSurface").mockImplementation((params) =>
        params.mutationBoundary
          ? withPrSurfaceMutationBoundary(surface, params.mutationBoundary)
          : surface,
      );
      const job = {
        id: randomUUID(),
        data: { workItemId },
        retryCount: 0,
        retryLimit: 3,
        startedOn: new Date(),
        expireInSeconds: 3600,
        signal: new AbortController().signal,
      } as JobWithMetadata<ReviewJobData>;
      const spec = {
        cfg,
        pool,
        boss,
        job,
        ...createWorkDefinitions({
          cfg,
          pool,
          boss,
          installationSurface: openInstallationSurface(),
        }).review,
      };
      const originalMethod =
        method === "handled stash error" || method === "published summary" ? "setLabels" : method;
      const execute: DurableJobSpec<"review">["execute"] = async (_item, env) => {
        await runInOperationIntentFrame("integration:crash", async () => {
          switch (originalMethod) {
            case "setAcknowledgementReaction":
              return env.prSurface.setAcknowledgementReaction(
                [{ kind: "pr", prNumber: 1 }],
                "eyes",
              );
            case "setReviewCommitStatus":
              return env.prSurface.setReviewCommitStatus("abc1234", {
                state: "pending",
                description: "original mutation",
              });
            case "setLabels":
              return env.prSurface.setLabels(["original mutation"]);
            case "finishReviewCheck":
              return env.prSurface.finishReviewCheck({
                checkRunId: 42,
                conclusion: "success",
                summary: "original mutation",
              });
            case "replyAt":
              return env.prSurface.replyAt(
                { kind: "prConversation", prNumber: 1 },
                `Original reply ${operationIntentMarker("integration:crash", workItemId)}`,
              );
          }
        });
        return { kind: "completed" };
      };
      await pool.query(
        `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'queued', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey],
      );
      const check = await surface.startReviewCheck("abc1234", workItemId);
      await recordReviewCheckRun(pool, {
        workItemId,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        leaseEpoch: null,
        detail: { status: "in_progress", headSha: "abc1234", externalId: workItemId },
      });
      if (method === "published summary") {
        controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "Published review", 70);
        await createPublishContext(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 70,
          leaseEpoch: null,
          detail: { findings: [] },
        }).record();
      }
      const originalNotice = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
      const merge = intentRepository.mergeOperationIntentDetail;
      let stashMissed = false;
      const fault = vi
        .spyOn(intentRepository, "mergeOperationIntentDetail")
        .mockImplementation(async (client, params) => {
          if (
            params.workItemId === workItemId &&
            Object.hasOwn(params.detail, "__result") &&
            !stashMissed
          ) {
            stashMissed = true;
            throw new Error("simulated death before result stash");
          }
          return merge(client, params);
        });
      try {
        if (method === "handled stash error") {
          await expect(
            durableJob.runDurableWorkItem({
              runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
              ...spec,
              execute,
            }),
          ).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          expect(await getWorkItem(pool, workItemId)).toMatchObject({
            status: "queued",
            attemptCount: 0,
          });
          const lease = await pool.query(
            "SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1",
            [resourceKey],
          );
          expect(lease.rows[0]?.work_item_id).toBeNull();
        } else {
          const acquisition = await acquirePrActorLease(pool, {
            resourceKey,
            workType: "review",
            workItemId,
            holderId: "crashed-integration-worker",
            ttlSeconds: 900,
          });
          expect(acquisition).toEqual({ acquired: true, leaseEpoch: 1 });
          await claimWorkForExecution(pool, workItemId, 1);
          const fenced = withPrSurfaceMutationBoundary(surface, {
            signal: job.signal,
            run: (mutation, mutate) =>
              publishOnce({
                client: pool,
                workItemId,
                leaseEpoch: 1,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                mutate,
                recover: mutation.recover as PublishOnceParams<
                  Awaited<ReturnType<typeof mutate>>
                >["recover"],
                allowsUndefinedResult: mutation.allowsUndefinedResult,
              }),
          });
          const item = await getWorkItem(pool, workItemId);
          if (item?.type !== "review") throw new Error("missing review work");
          await expect(
            execute(
              item,
              durableJob.createDurableExecutionContext({
                pool,
                item,
                prSurface: fenced,
                headSha: "abc1234",
                leaseEpoch: 1,
                job,
                beginAttempt: async () => {
                  const result = await beginWorkAttempt(pool, workItemId, 1, 4);
                  if (result.kind !== "started") throw new Error("work not admitted");
                  return { ...result.claim, resumed: true };
                },
                signal: job.signal,
                getClaim: () => undefined,
                getEscalation: () => undefined,
              }),
            ),
          ).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          expect(await getWorkItem(pool, workItemId)).toMatchObject({
            status: "running",
            attemptCount: 0,
          });
          const lease = await pool.query(
            "SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1",
            [resourceKey],
          );
          expect(lease.rows[0]?.work_item_id).toBe(workItemId);
          await pool.query(
            "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE resource_key = $1",
            [resourceKey],
          );
        }
        fault.mockRestore();
        expect(stashMissed).toBe(true);
        const intents = await pool.query(
          "SELECT operation_key, status, detail FROM operation_intents WHERE work_item_id = $1",
          [workItemId],
        );
        expect(intents.rows).toHaveLength(1);
        expect(intents.rows[0]).toMatchObject({ status: "pending", detail: { __mutating: true } });
        expect(Object.hasOwn(intents.rows[0].detail, "__result")).toBe(false);
        expect(controls.events.filter((event) => event.kind === originalMethod)).toHaveLength(1);

        const attemptCap = cfg.queue.retryLimit + 1;
        await pool.query("UPDATE agent_work_items SET attempt_count = $2 WHERE id = $1", [
          workItemId,
          attemptCap,
        ]);
        await durableJob.runDurableWorkItem({
          runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
          ...spec,
          execute,
        });
        expect(info).toHaveBeenCalledWith("agent_work_started", {
          type: "review",
          workItemId,
          resourceKey,
          leaseEpoch: 2,
        });
        if (method === "replyAt") {
          expect(info).toHaveBeenCalledWith("agent_work_completed", {
            type: "review",
            workItemId,
          });
        } else {
          expect(
            failureLog.mock.calls.map(([event, fields]) => [
              event,
              fields?.errorCode,
              fields?.retryDisposition,
            ]),
          ).toContainEqual([
            "agent_work_failed",
            "operation_intent.mutation_outcome_unknown",
            "terminal",
          ]);
        }
        expect(
          controls.events.filter(
            (event) =>
              event.kind === originalMethod &&
              (event.kind !== "setAcknowledgementReaction" || event.reaction === "eyes") &&
              (event.kind !== "finishReviewCheck" || event.checkRunId === 42),
          ),
        ).toHaveLength(1);
        expect(await getWorkItem(pool, workItemId)).toMatchObject({
          status: method === "replyAt" ? "completed" : "failed",
          attemptCount: attemptCap,
        });
        const epoch = await pool.query(
          "SELECT execution_epoch FROM agent_work_items WHERE id = $1",
          [workItemId],
        );
        expect(Number(epoch.rows[0]?.execution_epoch)).toBe(2);
        const notice = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
        if (method === "replyAt" || method === "published summary") {
          expect(notice?.body).toBe(originalNotice);
          if (method === "replyAt") expect(controls.replies).toHaveLength(1);
          expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(0);
        } else {
          expect(notice?.body).toContain("/review");
          expect(notice?.body).not.toContain("simulated death");
          expect(parseProgressRevisionState(notice?.body ?? "")).toMatchObject({ revision: 7 });
          expect(
            controls.events.filter((event) => event.kind === "upsertProgressComment"),
          ).toHaveLength(1);
          expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(0);
          expect(controls.events).toContainEqual({
            kind: "finishReviewCheck",
            checkRunId: check.id,
            conclusion: "action_required",
          });
        }
        const eventCount = controls.events.length;
        for (let replay = 0; replay < 3; replay++)
          await durableJob.runDurableWorkItem({
            runtime: createDurableRuntime({ installationSurface: openInstallationSurface() }),
            ...spec,
            execute,
          });
        expect(await getWorkItem(pool, workItemId)).toMatchObject({ attemptCount: attemptCap });
        expect(controls.events).toHaveLength(eventCount);
        console.info(
          "budget-survival-evidence",
          JSON.stringify({
            scenario: `recovery_at_cap:${method}`,
            originalMutations: 1,
            status: method === "replyAt" ? "completed" : "failed",
            quietRedeliveries: 3,
          }),
        );
        const outcome = await pool.query(
          "SELECT status, detail FROM operation_intents WHERE work_item_id = $1 AND operation_key = $2",
          [workItemId, intents.rows[0].operation_key],
        );
        if (method === "replyAt") {
          expect(outcome.rows[0]?.status).toBe("reconciled");
          expect(outcome.rows[0]?.detail.__result.commentId).toBeGreaterThan(0);
        } else {
          expect(outcome.rows[0]).toMatchObject({
            status: "outcome_unknown",
            detail: { unknownResolution: "terminal" },
          });
          expect(Object.hasOwn(outcome.rows[0].detail, "__result")).toBe(false);
        }
      } finally {
        vi.restoreAllMocks();
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );

  it.each([
    "cached terminal",
    "typed absence",
    "reconciled typed",
    "void ledger",
    "typed ledger outage",
    "provider outage",
    "lookup outage",
    "proven rejection",
  ] as const)("preserves evidence and replay contracts: %s", async (scenario) => {
    const workItemId = randomUUID();
    const resourceKey = `integration/evidence-${randomUUID()}#1`;
    const operationKey = "review:summary:evidence";
    await pool.query(
      `INSERT INTO agent_work_items
         (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
       VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, 'abc1234', 'review', $2, '{"mode":"review","source":"slash"}')`,
      [workItemId, resourceKey],
    );
    try {
      const ledger =
        scenario === "void ledger" ||
        scenario === "typed ledger outage" ||
        scenario === "typed absence";
      if (ledger)
        await createPublishContext(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 90,
          leaseEpoch: null,
          detail: {},
        }).record();
      await intentRepository.persistOperationIntent(pool, {
        workItemId,
        operationKey,
        mutationKind: "review_summary",
        detail: {
          step: "summary_comment",
          resourceKey,
          reviewLens: "review",
          ...(scenario === "proven rejection" ? {} : { __mutating: true }),
        },
      });
      if (scenario === "cached terminal" || scenario === "reconciled typed") {
        await intentRepository.reconcileOperationIntent(pool, {
          workItemId,
          operationKey,
          status: scenario === "cached terminal" ? "outcome_unknown" : "reconciled",
          detail: scenario === "cached terminal" ? { unknownResolution: "terminal" } : {},
        });
      }
      const mutate = vi.fn(async () => ({ commentId: 90 }));
      const recover = vi.fn(
        async (): Promise<
          { kind: "absent" } | { kind: "reconciled"; value: { commentId: number } }
        > => ({ kind: "absent" }),
      );
      const params = {
        client: pool,
        workItemId,
        operationKey,
        mutationKind: "review_summary",
        mutate,
        recover,
        allowsUndefinedResult: scenario === "void ledger",
      };
      if (
        scenario === "provider outage" ||
        scenario === "typed ledger outage" ||
        scenario === "void ledger"
      ) {
        recover.mockRejectedValueOnce(new Error("temporary observation failure"));
      }
      const lookup = vi.spyOn(reconciliation, "findCompletedPublishRecordId");
      const reconcile = vi.spyOn(intentRepository, "reconcileOperationIntent");
      if (scenario === "lookup outage")
        lookup.mockRejectedValueOnce(new Error("temporary ledger read failure"));
      if (scenario === "proven rejection") {
        mutate.mockRejectedValueOnce(
          Object.assign(new Error("provider rejected before acceptance"), { status: 422 }),
        );
        await expect(
          publishOnce({ ...params, isKnownNoAcceptanceError: () => true }),
        ).rejects.toMatchObject({
          code: "operation_intent.mutation_failed",
        });
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.status,
        ).toBe("failed");
        expect(await publishOnce(params)).toEqual({ commentId: 90 });
        expect(mutate).toHaveBeenCalledTimes(2);
      } else if (scenario === "void ledger") {
        expect(await publishOnce(params)).toBeUndefined();
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.detail
            .__result,
        ).toBeNull();
      } else {
        const error = await publishOnce(params).catch((failure: unknown) => failure);
        const transient =
          scenario === "provider outage" ||
          scenario === "lookup outage" ||
          scenario === "typed ledger outage";
        expect(error).toMatchObject({
          code:
            scenario === "provider outage"
              ? "operation_intent.recovery_failed"
              : scenario === "lookup outage"
                ? "operation_intent.publish_record_lookup_failed"
                : "operation_intent.mutation_outcome_unknown",
        });
        expect(retryDispositionFor(error)).toBe(transient ? "transient" : "terminal");
        const intent = await intentRepository.getOperationIntent(pool, workItemId, operationKey);
        expect(intent?.detail.__result).toBeUndefined();
        if (transient) {
          expect(intent?.detail.unknownResolution).toBeUndefined();
          recover.mockResolvedValue({ kind: "reconciled", value: { commentId: 90 } });
          expect(await publishOnce(params)).toEqual({ commentId: 90 });
          const readCount = recover.mock.calls.length;
          expect(await publishOnce(params)).toEqual({ commentId: 90 });
          expect(recover).toHaveBeenCalledTimes(readCount);
        } else if (scenario === "cached terminal" || scenario === "typed absence") {
          const readCount = recover.mock.calls.length;
          const lookupCount = lookup.mock.calls.length;
          for (let replay = 0; replay < 2; replay++) {
            const next = await publishOnce(params).catch((failure: unknown) => failure);
            expect(retryDispositionFor(next)).toBe("terminal");
          }
          expect(recover).toHaveBeenCalledTimes(readCount);
          expect(lookup).toHaveBeenCalledTimes(lookupCount);
          if (scenario === "cached terminal") {
            expect(recover).not.toHaveBeenCalled();
            expect(lookup).not.toHaveBeenCalled();
          }
        } else {
          expect(intent?.status).toBe("reconciled");
          expect(reconcile).not.toHaveBeenCalled();
        }
      }
      if (scenario !== "proven rejection") expect(mutate).not.toHaveBeenCalled();
      expect(
        retryDispositionFor(
          new AppError({
            domain: "operation_intent",
            kind: "mutation_outcome_unknown",
            message: "legacy unknown",
          }),
        ),
      ).toBe("transient");
    } finally {
      vi.restoreAllMocks();
      await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    }
  });

  it.each(["after the notice", "while the notice is written"] as const)(
    "keeps the review failure notice final against a late progress tick %s",
    async (timing) => {
      const workItemId = randomUUID();
      const resourceKey = `integration/failure-notice-${randomUUID()}#1`;
      const headSha = "abc1234";
      await pool.query(
        `INSERT INTO agent_work_items
           (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload)
         VALUES ($1, 'review', 'slash', 'running', 'o', 'r', 1, 42, $3, 'review', $2, '{"mode":"review","source":"slash"}')`,
        [workItemId, resourceKey, headSha],
      );
      const lease = await acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId,
        holderId: "m10-test",
        ttlSeconds: 120,
      });
      if (!lease.acquired) throw new Error("lease not acquired");
      const cfg = makeTestConfig();
      const boss = new PgBoss({ connectionString: cfg.runtime.databaseUrl });
      const { surface, controls } = createFakePrSurface(
        { owner: "o", repo: "r", prNumber: 1 },
        { headSha },
      );
      const tick = (progressRevision: 1 | 2) =>
        tickProgressComment({
          pool,
          workItemId,
          resourceKey,
          owner: "o",
          repo: "r",
          prNumber: 1,
          mode: "review",
          headSha,
          source: "slash",
          progressRevision,
          tickState: initialProgressTickState(),
          prSurface: surface,
        });
      try {
        await tick(1);
        const item = await getWorkItem(pool, workItemId);
        if (item?.type !== "review") throw new Error("review item missing");
        const execution = createReviewWorkExecution({
          cfg,
          pool,
          boss,
          installationSurface: openInstallationSurface(),
        });
        const noticeWritten = execution.onTerminalFailure?.(
          item,
          surface,
          new Error("dead"),
          lease.leaseEpoch,
        );
        if (timing === "after the notice") {
          await noticeWritten;
          await tick(2);
        } else {
          await Promise.all([noticeWritten, tick(2)]);
        }
        const comments = (await surface.listConversationComments()).filter((comment) =>
          comment.body.includes(REVIEW_SUMMARY_SENTINEL),
        );
        expect(comments).toHaveLength(1);
        expect(comments[0]?.body).toContain("Review did not finish");
        expect(comments[0]?.body).not.toContain("Recon");
        expect(parseProgressRevisionState(comments[0]?.body ?? "")).toEqual({
          revision: 7,
          workItemId,
        });
        expect(controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body).toBe(comments[0]?.body);
      } finally {
        await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM publish_records WHERE resource_key = $1", [resourceKey]);
        await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
      }
    },
  );
});
