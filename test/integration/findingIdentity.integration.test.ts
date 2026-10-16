import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { openReviewArtifactStore } from "../../src/agentWork/reviewArtifactRepository.js";
import { getOperationIntent } from "../../src/agentWork/operationIntentRepository.js";
import {
  deterministicInlineBatchId,
  reviewDuplicateOperationKey,
  reviewInlineBatchOperationKey,
} from "../../src/agentWork/publishOnce.js";
import {
  createFakePrSurface,
  type FakePrSurfaceControls,
  type PrSurface,
} from "../../src/github/prSurface.js";
import { reviewVerdict } from "../../src/agentWork/reviewVerdict.js";
import { publishVerification } from "../../src/agent/verification/publishVerification.js";
import {
  loadFindingInventory,
  loadFindingInventoryFromThreads,
  type FindingInventory,
} from "../../src/review/findingIdentity/findingInventory.js";
import {
  parseOwnedFindingMarker,
  parseOwnedReceipts,
  renderReceipt,
  type FindingId,
} from "../../src/review/findingIdentity/findingMarker.js";
import { AppError } from "../../src/errors/appError.js";
import { createOrchestratorPhaseRef } from "../../src/review/orchestrator/phaseToolPolicy.js";
import { buildPublishThreadTool } from "../../src/review/orchestrator/publishThreadTool.js";
import { buildDeclareDuplicateTool } from "../../src/review/orchestrator/declareDuplicateTool.js";
import { fetchBotFindingThreads } from "../../src/review/run/reviewPriorFeedback.js";
import { recordDeliveredFileRead } from "../../src/review/findings/evidenceLedger.js";
import {
  createFindingLedger,
  type FindingLedger,
} from "../../src/review/orchestrator/orchestratorTypes.js";
import { publishFindingBatch } from "../../src/review/publish/publishFindingBatch.js";
import { createReviewPublishSession } from "../../src/review/publish/reviewPublishSession.js";
import { publishReviewSummaryOnly } from "../../src/review/publish/publishSummaryOnly.js";
import { createReviewArtifactBinding } from "../../src/review/recovery/reviewArtifacts.js";
import { openReviewRecovery } from "../../src/review/recovery/reviewRecovery.js";
import { reviewPayloadFromFindings, type ReviewFinding } from "../../src/review/reviewSchema.js";
import type { ReviewPublishSession } from "../../src/review/publish/reviewPublishSession.js";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../../src/review/statusCopy.js";
import { makeTestConfig } from "../helpers/config.js";
import {
  createTestEvidenceLedger,
  seedEvidenceForFindings,
} from "../helpers/evidenceTestHelpers.js";
import {
  cachedDiffForLines,
  completeFindingInventory,
} from "../helpers/reviewPublishTestHelpers.js";
import { hasDatabase, integrationPool } from "./db.js";

const HEAD_SHA = "abc1234";
const LEASE_EPOCH = 7;

const findings: readonly ReviewFinding[] = [10, 11].map((line) => ({
  severity: "P1",
  file: "src/a.ts",
  startLine: line,
  endLine: line,
  title: `Null dereference at line ${line}`,
  detail: `The payload read at line ${line} can be null on this path.`,
  fixPrompt: "Guard the payload before dereferencing it.",
}));

describe.skipIf(!hasDatabase)("finding identity (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const rerunCleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of rerunCleanups.splice(0)) await cleanup();
  });

  async function seedReviewPublication() {
    const workItemId = randomUUID();
    const repo = `r-${workItemId}`;
    const resourceKey = `finding-identity-it/${repo}#1`;
    await pool.query(
      `INSERT INTO agent_work_items
        (id, type, source, status, owner, repo, pr_number, installation_id, head_sha, review_lens, resource_key, payload, execution_epoch)
       VALUES ($1, 'review', 'auto', 'running', 'finding-identity-it', $2, 1, 42, $3, 'review', $4, '{}', $5)`,
      [workItemId, repo, HEAD_SHA, resourceKey, LEASE_EPOCH],
    );
    await pool.query(
      `INSERT INTO pr_actor_leases (resource_key, work_type, lease_epoch, work_item_id, holder_id, expires_at)
       VALUES ($1, 'review', $2, $3, 'finding-identity-it', now() + interval '5 minutes')`,
      [resourceKey, LEASE_EPOCH, workItemId],
    );
    const binding = createReviewArtifactBinding(
      {
        workItemId,
        resourceKey,
        owner: "finding-identity-it",
        repo,
        prNumber: 1,
        installationId: 42,
        baseSha: "base",
        headSha: HEAD_SHA,
        mode: "review",
      },
      "a".repeat(64),
    );
    const { surface, controls } = createFakePrSurface({
      owner: "finding-identity-it",
      repo,
      prNumber: 1,
    });

    const attempt = (
      client: Pool,
      prSurface: PrSurface,
      observations: readonly ReviewFinding[] = [],
      findingInventory: FindingInventory = completeFindingInventory(),
    ) => {
      const evidenceLedger = createTestEvidenceLedger(HEAD_SHA);
      seedEvidenceForFindings(evidenceLedger, [...findings, ...observations]);
      recordDeliveredFileRead(evidenceLedger, {
        path: "src/a.ts",
        headSha: HEAD_SHA,
        tool: "readWorkspaceFile",
        startLine: 10,
        endLine: 11,
        content: "line ten\nline eleven",
      });
      const recovery = openReviewRecovery(
        binding,
        openReviewArtifactStore(client, binding, LEASE_EPOCH),
      );
      const session = createReviewPublishSession({
        cfg: makeTestConfig(),
        ctx: {
          owner: "finding-identity-it",
          repo,
          prNumber: 1,
          headSha: HEAD_SHA,
          hasDescriptionReviewMap: false,
        },
        workItemId,
        recovery,
        prSurface,
        findingInventory,
        cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 11]),
        resolveProgressCommentUrl: async () =>
          `https://github.com/finding-identity-it/${repo}/pull/1#issuecomment-99`,
        operationIntent: { client, workItemId, resourceKey, leaseEpoch: LEASE_EPOCH },
      });
      return {
        session,
        recovery,
        input: { source: "correctness" as const, ledger: createFindingLedger(), evidenceLedger },
      };
    };

    const cleanup = async () => {
      await pool.query("DELETE FROM pr_actor_leases WHERE resource_key = $1", [resourceKey]);
      await pool.query("DELETE FROM agent_work_items WHERE id = $1", [workItemId]);
    };

    return { workItemId, resourceKey, surface, controls, attempt, cleanup };
  }

  async function rerun(
    surface: PrSurface,
    observations: readonly ReviewFinding[] = [],
    findingInventory?: FindingInventory,
  ) {
    const next = await seedReviewPublication();
    rerunCleanups.push(next.cleanup);
    return {
      ...next.attempt(pool, surface, observations, findingInventory),
      workItemId: next.workItemId,
      resourceKey: next.resourceKey,
    };
  }

  async function publishSummaryWithVerdict(
    surface: PrSurface,
    run: Awaited<ReturnType<typeof rerun>>,
    ledger: FindingLedger,
  ) {
    const verdictTarget = {
      pool,
      workItemId: run.workItemId,
      resourceKey: run.resourceKey,
      leaseEpoch: LEASE_EPOCH,
    };
    await reviewVerdict({
      ...verdictTarget,
      prSurface: surface,
      owner: "finding-identity-it",
      repo: surface.repo,
      prNumber: 1,
      reviewLens: "review",
      headSha: HEAD_SHA,
      commitStatusEnabled: false,
    }).pending();
    return publishReviewSummaryOnly(
      { ...run.session, verdict: verdictTarget },
      { payload: reviewPayloadFromFindings([]), ledger },
    );
  }

  function lastSummaryBody(controls: FakePrSurfaceControls): string {
    const upserts = controls.events.flatMap((event) =>
      event.kind === "upsertProgressComment" ? [event.body] : [],
    );
    return upserts.at(-1) ?? "";
  }

  function checkConclusions(controls: FakePrSurfaceControls) {
    return controls.events.flatMap((event) =>
      event.kind === "finishReviewCheck" ? [event.conclusion] : [],
    );
  }

  function threadTool(
    run: ReturnType<Awaited<ReturnType<typeof seedReviewPublication>>["attempt"]>,
    inventory: FindingInventory,
  ) {
    const tool = buildPublishThreadTool({
      phaseRef: createOrchestratorPhaseRef("judgment"),
      session: run.session,
      inventory,
      policy: { evidenceLedger: run.input.evidenceLedger },
    });
    tool.setSource("correctness");
    return tool;
  }

  function openIdAt(inventory: FindingInventory, line: number): FindingId {
    const match = [...inventory.findings.values()].find(
      (entry) => entry.state === "open" && entry.line === line,
    );
    if (match == null) throw new Error(`expected an open finding at line ${line}`);
    return match.id;
  }

  function observed(line: number, extras: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
      severity: "P1",
      file: "src/a.ts",
      startLine: line,
      endLine: line,
      title: `Payload can be null near line ${line}`,
      detail: `A null payload reaches the dereference near line ${line}.`,
      fixPrompt: "Check the payload for null first.",
      ...extras,
    };
  }

  async function publishFirstRound(
    seeded: Awaited<ReturnType<typeof seedReviewPublication>>,
  ): Promise<number> {
    const first = seeded.attempt(pool, seeded.surface);
    const published = await publishFindingBatch(findings, first.session, first.input);
    if (published.kind !== "published") throw new Error("expected the first round to publish");
    const [reviewId] = published.delta.inlineReviewIds;
    if (reviewId == null) throw new Error("expected an inline review");
    return reviewId;
  }

  const noPathChanges = { renames: new Map<string, string>(), deletedPaths: new Set<string>() };

  const lineTenCopies: readonly ReviewFinding[] = [
    "Null dereference at line 10",
    "Payload is dereferenced without a null check",
    "Unchecked payload read crashes on null",
  ].map((title) => observed(10, { title }));

  async function publishCopies(
    seeded: Awaited<ReturnType<typeof seedReviewPublication>>,
    copies: readonly ReviewFinding[],
  ): Promise<{ readonly reviewId: number; readonly ids: readonly FindingId[] }> {
    const first = seeded.attempt(pool, seeded.surface, copies);
    const published = await publishFindingBatch(copies, first.session, first.input);
    if (published.kind !== "published") throw new Error("expected the copies to publish");
    const [reviewId] = published.delta.inlineReviewIds;
    if (reviewId == null) throw new Error("expected an inline review");
    const inventory = await loadFindingInventory(seeded.surface, noPathChanges);
    const ids = [...inventory.findings.values()]
      .filter((entry) => entry.state === "open" && entry.line === 10)
      .map((entry) => entry.id);
    if (ids.length !== copies.length) throw new Error("expected one open thread per copy");
    return { reviewId, ids };
  }

  async function addHumanReply(
    surface: PrSurface,
    controls: FakePrSurfaceControls,
    rootCommentId: number,
  ) {
    const { comments } = await surface.listReviewComments();
    controls.setReviewComments([
      ...comments,
      {
        id: 900_000 + rootCommentId,
        inReplyToId: rootCommentId,
        pullRequestReviewId: null,
        userId: 7,
        authorLogin: "maintainer",
        authorAssociation: "MEMBER",
        body: "Is this the same problem as the other thread?",
        path: null,
        line: null,
        originalLine: null,
        htmlUrl: "",
      },
    ]);
  }

  async function receiptsByThread(surface: PrSurface) {
    const botLogin = await surface.getBotLogin();
    const { threads } = await surface.listInlineReviewThreads();
    return new Map(
      threads.map((thread) => [
        thread.rootCommentId,
        {
          isResolved: thread.isResolved,
          receipts: parseOwnedReceipts(thread.comments, botLogin),
        },
      ]),
    );
  }

  function declareTool(session: ReviewPublishSession) {
    return buildDeclareDuplicateTool({
      phaseRef: createOrchestratorPhaseRef("judgment"),
      session,
    });
  }

  it("recovers a batch killed after GitHub accepted it by the finding markers GitHub returns", async () => {
    const { workItemId, surface, controls, attempt, cleanup } = await seedReviewPublication();

    try {
      const killedPool = integrationPool();
      const acceptPublish = surface.publishThreadBatch.bind(surface);
      let markAccepted: () => void = () => undefined;
      const accepted = new Promise<void>((resolve) => {
        markAccepted = resolve;
      });
      vi.spyOn(surface, "publishThreadBatch").mockImplementationOnce(async (review) => {
        await acceptPublish(review);
        markAccepted();
        return new Promise<never>(() => undefined);
      });
      const killed = attempt(killedPool, surface);
      void publishFindingBatch(findings, killed.session, killed.input);
      await accepted;
      await killedPool.end();
      vi.restoreAllMocks();

      const reviewsBefore = await surface.listPullRequestReviews();
      const threadsBefore = await surface.listInlineReviewThreads();
      expect(controls.threadBatches).toHaveLength(1);
      expect(reviewsBefore).toHaveLength(1);
      const acceptedReviewId = reviewsBefore[0]?.id;

      const retry = attempt(pool, surface);
      const decisions = await retry.recovery.decisions();
      expect(decisions).toHaveLength(1);
      const [decision] = decisions;
      const journaled =
        decision?.prepared.artifact.canonical.kind === "threads"
          ? decision.prepared.artifact.canonical.inline.map((placement) => placement.findingId)
          : [];
      expect(journaled).toHaveLength(2);
      const operationKey = reviewInlineBatchOperationKey(
        deterministicInlineBatchId({ workItemId, headSha: HEAD_SHA, findingIds: journaled }),
      );
      expect(decision?.prepared.artifact.operationKey).toBe(operationKey);
      const pending = await getOperationIntent(pool, workItemId, operationKey);
      expect(pending?.status).toBe("pending");

      const recovered = await publishFindingBatch([], retry.session, {
        ...retry.input,
        recoveryDecision: decision,
      });

      expect(controls.threadBatches).toHaveLength(1);
      expect(await surface.listPullRequestReviews()).toEqual(reviewsBefore);
      expect((await surface.listInlineReviewThreads()).threads).toHaveLength(
        threadsBefore.threads.length,
      );
      expect(recovered.kind).toBe("published");
      if (recovered.kind !== "published") return;
      const posted = recovered.delta.accepted.flatMap((entry) =>
        entry.kind === "posted" ? [entry] : [],
      );
      expect(posted.map((entry) => entry.reviewId)).toEqual([acceptedReviewId, acceptedReviewId]);
      expect(recovered.delta.inlineReviewIds).toEqual([acceptedReviewId]);

      const botLogin = await surface.getBotLogin();
      const markerIds = (await surface.listReviewComments()).comments
        .filter((comment) => comment.pullRequestReviewId === acceptedReviewId)
        .map(
          (comment) =>
            parseOwnedFindingMarker(
              { body: comment.body, authorLogin: comment.authorLogin, isRoot: true },
              botLogin,
            )?.id,
        );
      expect(markerIds).toHaveLength(journaled.length);
      expect(new Set(markerIds)).toEqual(new Set(journaled));
      expect(posted.map((entry) => entry.findingId)).toHaveLength(markerIds.length);
      expect(new Set(posted.map((entry) => entry.findingId))).toEqual(new Set(markerIds));
      expect((await getOperationIntent(pool, workItemId, operationKey))?.status).toBe("reconciled");
    } finally {
      await cleanup();
    }
  });

  it("rebuilds the same finding ids from GitHub after database loss and posts no duplicate", async () => {
    const { workItemId, surface, controls, attempt, cleanup } = await seedReviewPublication();

    try {
      const first = attempt(pool, surface);
      const published = await publishFindingBatch(findings, first.session, first.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const recordedIds = published.delta.accepted.flatMap((entry) =>
        entry.kind === "posted" ? [entry.findingId] : [],
      );
      expect(recordedIds).toHaveLength(findings.length);
      const durableRows = async () =>
        (
          await pool.query<{ count: string }>(
            `SELECT (SELECT count(*) FROM publish_records WHERE work_item_id = $1)
                  + (SELECT count(*) FROM operation_intents WHERE work_item_id = $1)
                  + (SELECT count(*) FROM review_run_artifacts WHERE work_item_id = $1) AS count`,
            [workItemId],
          )
        ).rows[0]?.count;
      expect(Number(await durableRows())).toBeGreaterThan(0);

      await cleanup();
      expect(Number(await durableRows())).toBe(0);

      const inventory = await loadFindingInventory(surface, noPathChanges);
      expect(inventory.completeness).toBe("complete");
      const open = [...inventory.findings.values()].filter((finding) => finding.state === "open");
      expect(open.every((finding) => !finding.legacy)).toBe(true);
      expect(new Set(open.map((finding) => finding.id))).toEqual(new Set(recordedIds));
      expect(new Set(open.map((finding) => finding.line))).toEqual(new Set([10, 11]));

      const batchesBefore = controls.threadBatches.length;
      const tool = threadTool(await rerun(surface), inventory);
      const result = await tool.executor({
        findings: findings.map((finding) => ({
          ...finding,
          relation: { kind: "continues", findingId: openIdAt(inventory, finding.startLine) },
        })),
      });
      expect(controls.threadBatches).toHaveLength(batchesBefore);
      expect(result.kind).toBe("empty");
      if (result.kind !== "empty") return;
      expect(result.delta.accepted).toEqual([]);
      expect(new Set(result.delta.reaffirmed.map((entry) => entry.id))).toEqual(
        new Set(recordedIds),
      );
      expect(result.delta.reaffirmed.every((entry) => entry.heldBy === "thread")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("reports a partial inventory and blocks resolution receipts", async () => {
    const { workItemId, resourceKey, surface, controls, attempt, cleanup } =
      await seedReviewPublication();
    const botUserId = 4242;

    try {
      const first = attempt(pool, surface);
      const published = await publishFindingBatch(findings, first.session, first.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const [reviewId] = published.delta.inlineReviewIds;
      if (reviewId == null) throw new Error("expected an inline review");
      controls.setReviewComments(
        (await surface.listReviewComments()).comments.map((comment) => ({
          ...comment,
          userId: botUserId,
        })),
      );
      controls.setPullRequestReviews(
        (await surface.listPullRequestReviews()).map((review) => ({
          ...review,
          userId: botUserId,
        })),
      );
      const botLogin = await surface.getBotLogin();
      const candidates = async () => {
        const threads = await surface.listInlineReviewThreads();
        const inventory = await loadFindingInventoryFromThreads(surface, {
          threads,
          botLogin,
          renames: new Map(),
          deletedPaths: new Set(),
        });
        const found = await fetchBotFindingThreads(surface, {
          botUserId,
          inventory,
          publishRecordLenses: new Map([[reviewId, "review" as const]]),
        });
        return { inventory, threads, found };
      };

      const complete = await candidates();
      expect(complete.inventory.completeness).toBe("complete");
      expect(complete.found).toHaveLength(findings.length);
      expect(new Set(complete.found.map((thread) => thread.findingId))).toEqual(
        new Set(complete.inventory.findings.keys()),
      );

      controls.setThreadResolutionStatus("partial", "thread page missing");
      const partial = await candidates();
      expect(partial.inventory.completeness).toBe("partial");
      expect(partial.found).toHaveLength(findings.length);
      expect(partial.found.every((thread) => thread.findingId == null)).toBe(true);

      const [fixedThread, dismissedThread] = partial.found;
      if (fixedThread == null || dismissedThread == null) throw new Error("expected two threads");
      const eventsBefore = controls.events.length;
      const result = await publishVerification({
        pool,
        workItemId,
        resourceKey,
        leaseEpoch: LEASE_EPOCH,
        installationId: 42,
        owner: "finding-identity-it",
        repo: surface.repo,
        prNumber: 1,
        headSha: HEAD_SHA,
        prSurface: surface,
        inventory: partial.found,
        resolutionByRootCommentId: partial.threads.byRootCommentId,
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: fixedThread.rootCommentId,
              evidence: "guarded",
              commitSha: "abcdef1",
            },
            {
              verdict: "dismissed",
              threadRootCommentId: dismissedThread.rootCommentId,
              evidence: "intentional",
            },
          ],
        },
        changedFilePaths: ["src/a.ts"],
        policyResult: { kind: "absent" },
      });

      expect(result.degradation).toEqual(["verdict_mapping_incomplete"]);
      const writes = controls.events
        .slice(eventsBefore)
        .filter(
          (event) =>
            event.kind === "resolveInlineReviewThread" ||
            event.kind === "replyAt" ||
            event.kind === "editReviewComment",
        );
      expect(writes).toEqual([]);
      expect(controls.replies).toHaveLength(0);
      expect(
        (await surface.listInlineReviewThreads()).threads.every((thread) => !thread.isResolved),
      ).toBe(true);

      controls.setThreadResolutionStatus("ok");
      const restored = await candidates();
      const silentlyFixed = restored.found.find(
        (thread) => thread.rootCommentId === fixedThread.rootCommentId,
      );
      if (silentlyFixed?.findingId == null) throw new Error("expected a complete candidate");
      const fixedResult = await publishVerification({
        pool,
        workItemId,
        resourceKey,
        leaseEpoch: LEASE_EPOCH,
        installationId: 42,
        owner: "finding-identity-it",
        repo: surface.repo,
        prNumber: 1,
        headSha: HEAD_SHA,
        prSurface: surface,
        inventory: restored.found,
        resolutionByRootCommentId: restored.threads.byRootCommentId,
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: silentlyFixed.rootCommentId,
              evidence: "guarded",
              commitSha: "abcdef1",
            },
          ],
        },
        changedFilePaths: ["src/a.ts"],
        policyResult: { kind: "absent" },
      });
      expect(fixedResult.degradation).toEqual([]);
      expect(controls.replies).toHaveLength(0);
      const fixedRoot = (await surface.listInlineReviewThreads()).threads.find(
        (thread) => thread.rootCommentId === silentlyFixed.rootCommentId,
      );
      expect(fixedRoot?.isResolved).toBe(true);
      expect(fixedRoot?.comments).toHaveLength(1);
      expect(
        fixedRoot?.comments[0]?.body.split(`kind=fixed id=${silentlyFixed.findingId}`),
      ).toHaveLength(2);
      const rebuilt = await loadFindingInventory(surface, noPathChanges);
      expect(rebuilt.findings.get(silentlyFixed.findingId)).toMatchObject({
        state: "resolved",
        resolution: "fixed",
      });
    } finally {
      await cleanup();
    }
  });

  it("keeps reworded, moved, other-lens, and renamed observations on their open threads", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      await publishFirstRound(seeded);
      const batchesBefore = controls.threadBatches.length;
      const inventory = await loadFindingInventory(surface, noPathChanges);
      expect(inventory.completeness).toBe("complete");
      const lineTen = openIdAt(inventory, 10);
      const lineEleven = openIdAt(inventory, 11);
      const reworded = observed(10);
      const moved = observed(11 + 10, { title: "Null payload reaches the dereference" });
      const otherLens = observed(10, { title: "Unchecked payload is a crash vector" });
      const tool = threadTool(await rerun(surface, [reworded, moved, otherLens]), inventory);

      const sameLens = await tool.executor({
        findings: [
          { ...reworded, relation: { kind: "continues", findingId: lineTen } },
          { ...moved, relation: { kind: "continues", findingId: lineEleven } },
        ],
      });
      tool.setSource("security");
      const crossLens = await tool.executor({
        findings: [{ ...otherLens, relation: { kind: "continues", findingId: lineTen } }],
      });

      const renamed = observed(10, { file: "src/b.ts" });
      const renamedInventory = await loadFindingInventory(surface, {
        renames: new Map([["src/a.ts", "src/b.ts"]]),
        deletedPaths: new Set(),
      });
      const renamedTool = threadTool(await rerun(surface, [renamed]), renamedInventory);
      const afterRename = await renamedTool.executor({
        findings: [{ ...renamed, relation: { kind: "continues", findingId: lineTen } }],
      });

      expect(controls.threadBatches).toHaveLength(batchesBefore);
      const reaffirmed = [sameLens, crossLens, afterRename].flatMap((result) =>
        result.kind === "empty" ? result.delta.reaffirmed : [],
      );
      expect(reaffirmed.map((entry) => [entry.id, entry.heldBy])).toEqual([
        [lineTen, "thread"],
        [lineEleven, "thread"],
        [lineTen, "thread"],
        [lineTen, "thread"],
      ]);
      expect(reaffirmed.map((entry) => entry.source)).toEqual([
        "correctness",
        "correctness",
        "security",
        "correctness",
      ]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("asks once about an unanswered overlap, then holds the finding summary-only", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      await publishFirstRound(seeded);
      const batchesBefore = controls.threadBatches.length;
      const inventory = await loadFindingInventory(surface, noPathChanges);
      const lineTen = openIdAt(inventory, 10);
      const nearby = observed(12, { title: "Retry loop never terminates" });
      const tool = threadTool(await rerun(surface, [nearby]), inventory);

      const asked = await tool.executor({ findings: [nearby] }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(asked).toBeInstanceOf(AppError);
      if (!(asked instanceof AppError)) return;
      expect(asked.code).toBe("review.publish_thread_overlap_unanswered");
      expect(asked.message).toContain(lineTen);
      expect(controls.threadBatches).toHaveLength(batchesBefore);

      const held = await tool.executor({ findings: [nearby] });
      expect(controls.threadBatches).toHaveLength(batchesBefore);
      expect(held.kind).toBe("empty");
      if (held.kind !== "empty") return;
      expect(held.delta.accepted).toEqual([
        expect.objectContaining({ kind: "summary_only", reason: "unanswered_overlap" }),
      ]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("keeps a dismissed finding suppressed and reopens a fixed one with a reopens marker", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      const reviewId = await publishFirstRound(seeded);
      const before = await loadFindingInventory(surface, noPathChanges);
      const fixedId = openIdAt(before, 10);
      const dismissedId = openIdAt(before, 11);
      const roots = (await surface.listReviewComments()).comments.filter(
        (comment) => comment.pullRequestReviewId === reviewId,
      );
      const fixedRoot = roots.find((comment) => comment.line === 10);
      if (fixedRoot == null) throw new Error("expected the line 10 root comment");
      await surface.replyAt(
        { kind: "inlineReviewThread", prNumber: 1, inReplyToCommentId: fixedRoot.id },
        renderReceipt({ kind: "fixed", id: fixedId }),
      );
      for (const thread of before.findings.values()) {
        if (thread.threadId != null) await surface.resolveInlineReviewThread(thread.threadId);
      }
      const inventory = await loadFindingInventory(surface, noPathChanges);
      expect(inventory.findings.get(fixedId)).toMatchObject({ resolution: "fixed" });
      expect(inventory.findings.get(dismissedId)).toMatchObject({ resolution: "dismissed" });
      const batchesBefore = controls.threadBatches.length;
      const regressed = observed(10);
      const repeated = observed(11);
      const tool = threadTool(await rerun(surface, [regressed, repeated]), inventory);

      const result = await tool.executor({
        findings: [
          { ...regressed, relation: { kind: "continues", findingId: fixedId } },
          { ...repeated, relation: { kind: "continues", findingId: dismissedId } },
        ],
      });

      expect(controls.threadBatches).toHaveLength(batchesBefore + 1);
      expect(controls.threadBatches.at(-1)?.comments).toHaveLength(1);
      expect(result.kind).toBe("published");
      if (result.kind !== "published") return;
      expect(result.delta.reaffirmed).toEqual([]);
      expect(result.delta.suppressedDismissedCount).toBe(1);
      const [reopened] = result.delta.accepted;
      expect(reopened).toMatchObject({ kind: "posted", reopens: fixedId });
      const botLogin = await surface.getBotLogin();
      const marker = parseOwnedFindingMarker(
        {
          body: controls.threadBatches.at(-1)?.comments?.[0]?.body ?? "",
          authorLogin: botLogin,
          isRoot: true,
        },
        botLogin,
      );
      expect(marker).toMatchObject({ id: reopened?.findingId, reopens: fixedId });
      expect(marker?.id).not.toBe(fixedId);
      const after = await loadFindingInventory(surface, noPathChanges);
      expect(after.findings.get(dismissedId)).toMatchObject({ resolution: "dismissed" });
      expect(
        [...after.findings.values()].filter((entry) => entry.state === "open").map((e) => e.id),
      ).toEqual([marker?.id]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("lists open threads a rerun did not recheck and fails the check on them", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      await publishFirstRound(seeded);
      const inventory = await loadFindingInventory(surface, noPathChanges);
      const lineTen = openIdAt(inventory, 10);
      const lineEleven = openIdAt(inventory, 11);
      const lineElevenUrl = inventory.findings.get(lineEleven)?.url;
      if (lineElevenUrl == null) throw new Error("expected the line 11 thread url");

      const silent = await rerun(surface, [], inventory);
      const silentResult = await publishSummaryWithVerdict(surface, silent, silent.input.ledger);
      expect(silentResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 2 },
      });
      expect(lastSummaryBody(controls).split("Open, not rechecked")).toHaveLength(3);
      expect(lastSummaryBody(controls)).toContain(lineElevenUrl);

      const reaffirmed = observed(10);
      const partialRun = await rerun(surface, [reaffirmed], inventory);
      const tool = threadTool(partialRun, inventory);
      await tool.executor({
        findings: [{ ...reaffirmed, relation: { kind: "continues", findingId: lineTen } }],
      });
      const partialResult = await publishSummaryWithVerdict(surface, partialRun, tool.getLedger());
      expect(partialResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 2 },
      });
      const body = lastSummaryBody(controls);
      expect(body.split("Open, not rechecked")).toHaveLength(2);
      expect(body).toContain(lineElevenUrl);
      expect(checkConclusions(controls)).toEqual(["failure", "failure"]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("reports an incomplete inventory as a neutral check unless a finding blocks", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      controls.setThreadResolutionStatus("partial", "thread page missing");
      const empty = await loadFindingInventory(surface, noPathChanges);
      expect(empty.completeness).toBe("partial");
      const quiet = await rerun(surface, [], empty);
      const quietResult = await publishSummaryWithVerdict(surface, quiet, quiet.input.ledger);
      expect(quietResult).toMatchObject({
        kind: "published",
        check: { conclusion: "neutral", blockingCount: 0 },
      });
      expect(lastSummaryBody(controls)).toContain(FINDING_INVENTORY_UNAVAILABLE_NOTE);

      controls.setThreadResolutionStatus("ok");
      await publishFirstRound(seeded);
      controls.setThreadResolutionStatus("partial", "thread page missing");
      const carried = await loadFindingInventory(surface, noPathChanges);
      expect(carried.completeness).toBe("partial");
      const blocked = await rerun(surface, [], carried);
      const blockedResult = await publishSummaryWithVerdict(surface, blocked, blocked.input.ledger);
      expect(blockedResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 2 },
      });
      expect(lastSummaryBody(controls)).toContain(FINDING_INVENTORY_UNAVAILABLE_NOTE);
      expect(checkConclusions(controls)).toEqual(["neutral", "failure"]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("links each duplicate thread to one canonical thread once and resolves only undiscussed copies", async () => {
    const seeded = await seedReviewPublication();
    const { surface, controls } = seeded;

    try {
      const { ids } = await publishCopies(seeded, lineTenCopies);
      const published = await loadFindingInventory(surface, noPathChanges);
      const rootOf = (id: FindingId) => {
        const root = published.findings.get(id)?.rootCommentId;
        if (root == null) throw new Error("expected a thread root");
        return root;
      };
      const [firstDiscussed, secondDiscussed, undiscussed] = ids;
      if (firstDiscussed == null || secondDiscussed == null || undiscussed == null) {
        throw new Error("expected three copies");
      }
      await addHumanReply(surface, controls, rootOf(firstDiscussed));
      await addHumanReply(surface, controls, rootOf(secondDiscussed));
      const inventory = await loadFindingInventory(surface, noPathChanges);

      const run = await rerun(surface, [], inventory);
      const declared = await declareTool(run.session).executor({
        findingIds: [undiscussed, secondDiscussed, firstDiscussed],
        reason: "All three describe the unchecked payload dereference at line 10.",
      });
      expect(declared.kind).toBe("accepted");
      if (declared.kind !== "accepted") return;
      expect([firstDiscussed, secondDiscussed]).toContain(declared.canonicalId);
      expect(declared.resolves).toEqual([undiscussed]);
      const [linkedOnly] = declared.linksOnly;
      expect(declared.linksOnly).toHaveLength(1);
      expect(linkedOnly).not.toBe(declared.canonicalId);
      if (linkedOnly == null) return;
      const canonicalUrl = inventory.findings.get(declared.canonicalId)?.url;
      if (canonicalUrl == null) throw new Error("expected a canonical url");

      const result = await publishSummaryWithVerdict(surface, run, run.input.ledger);
      expect(result).toMatchObject({ kind: "published", check: { blockingCount: 1 } });
      const body = lastSummaryBody(controls);
      expect(body).toContain(
        `Resolved this run: 1 duplicate (tracked in [thread](${canonicalUrl})).`,
      );
      expect(body).toContain(
        `Linked 1 discussed duplicate to [thread](${canonicalUrl}) and left it open.`,
      );

      const threads = await receiptsByThread(surface);
      const duplicateReceipts = (id: FindingId) =>
        threads
          .get(rootOf(id))
          ?.receipts.filter(
            (receipt) =>
              receipt.kind === "duplicate" &&
              receipt.id === id &&
              receipt.canonical === declared.canonicalId,
          ) ?? [];
      expect(duplicateReceipts(undiscussed)).toHaveLength(1);
      expect(duplicateReceipts(linkedOnly)).toHaveLength(1);
      expect(threads.get(rootOf(declared.canonicalId))).toEqual({
        isResolved: false,
        receipts: [],
      });
      expect(threads.get(rootOf(undiscussed))?.isResolved).toBe(true);
      expect(threads.get(rootOf(linkedOnly))?.isResolved).toBe(false);
      expect(
        controls.replies.filter((reply) => reply.body.startsWith(`Tracked in ${canonicalUrl}.`)),
      ).toHaveLength(2);
      for (const [kind, duplicateId] of [
        ["duplicate_reply", undiscussed],
        ["duplicate_resolve", undiscussed],
        ["duplicate_reply", linkedOnly],
      ] as const) {
        const threadId = published.findings.get(duplicateId)?.threadId;
        if (threadId == null) throw new Error("expected a thread id");
        const operationKey = reviewDuplicateOperationKey({
          kind,
          duplicateId,
          canonicalId: declared.canonicalId,
          threadId,
        });
        expect((await getOperationIntent(pool, run.workItemId, operationKey))?.status).toBe(
          "reconciled",
        );
      }

      const mutationsBefore = controls.events.filter(
        (event) => event.kind === "replyAt" || event.kind === "resolveInlineReviewThread",
      ).length;
      const afterInventory = await loadFindingInventory(surface, noPathChanges);
      expect(afterInventory.findings.get(undiscussed)?.state).toBe("resolved");
      const again = await rerun(surface, [], afterInventory);
      const redeclared = await declareTool(again.session).executor({
        findingIds: [declared.canonicalId, linkedOnly],
        reason: "Still the same unchecked payload dereference.",
      });
      expect(redeclared).toMatchObject({ kind: "accepted", canonicalId: declared.canonicalId });
      await publishSummaryWithVerdict(surface, again, again.input.ledger);
      expect(
        controls.events.filter(
          (event) => event.kind === "replyAt" || event.kind === "resolveInlineReviewThread",
        ),
      ).toHaveLength(mutationsBefore);
      expect(lastSummaryBody(controls)).not.toContain("Resolved this run");
    } finally {
      await seeded.cleanup();
    }
  });

  it("serializes duplicate cleanup and verification on one PR so no thread gets a second receipt of a kind", async () => {
    const seeded = await seedReviewPublication();
    const { workItemId, resourceKey, surface, controls } = seeded;
    const botUserId = 4242;

    try {
      const { reviewId, ids } = await publishCopies(seeded, lineTenCopies.slice(0, 2));
      controls.setReviewComments(
        (await surface.listReviewComments()).comments.map((comment) => ({
          ...comment,
          userId: botUserId,
        })),
      );
      controls.setPullRequestReviews(
        (await surface.listPullRequestReviews()).map((review) => ({
          ...review,
          userId: botUserId,
        })),
      );
      const inventory = await loadFindingInventory(surface, noPathChanges);
      const [olderId, newerId] = ids;
      if (olderId == null || newerId == null) throw new Error("expected two copies");

      const attempts = [0, 1].map(() => seeded.attempt(pool, surface, [], inventory));
      const declared = await Promise.all(
        attempts.map((attempt) =>
          declareTool(attempt.session).executor({
            findingIds: [olderId, newerId],
            reason: "Both describe the unchecked payload dereference at line 10.",
          }),
        ),
      );
      const [plan] = declared;
      if (plan?.kind !== "accepted") throw new Error("expected the duplicate group to be accepted");
      const [copyId] = plan.resolves;
      if (copyId == null) throw new Error("expected one copy to resolve");
      const copyRoot = inventory.findings.get(copyId)?.rootCommentId;
      const canonicalRoot = inventory.findings.get(plan.canonicalId)?.rootCommentId;
      if (copyRoot == null || canonicalRoot == null) throw new Error("expected thread roots");

      const listed = await surface.listInlineReviewThreads();
      const verificationThreads = await fetchBotFindingThreads(surface, {
        botUserId,
        inventory,
        publishRecordLenses: new Map([[reviewId, "review" as const]]),
      });

      await Promise.all([
        ...attempts.map((attempt) =>
          attempt.session.duplicateCleanup.clean({ ...attempt.session, pool }),
        ),
        publishVerification({
          pool,
          workItemId,
          resourceKey,
          leaseEpoch: LEASE_EPOCH,
          installationId: 42,
          owner: "finding-identity-it",
          repo: surface.repo,
          prNumber: 1,
          headSha: HEAD_SHA,
          prSurface: surface,
          inventory: verificationThreads,
          resolutionByRootCommentId: listed.byRootCommentId,
          payload: {
            verdicts: [
              {
                verdict: "fixed",
                threadRootCommentId: copyRoot,
                evidence: "guarded",
                commitSha: "abcdef1",
              },
            ],
          },
          changedFilePaths: ["src/a.ts"],
          policyResult: { kind: "absent" },
        }),
      ]);

      const threads = await receiptsByThread(surface);
      const copy = threads.get(copyRoot);
      expect(copy?.isResolved).toBe(true);
      const copyKinds = (copy?.receipts ?? []).map((receipt) => receipt.kind);
      expect(copyKinds.filter((kind) => kind === "fixed")).toHaveLength(1);
      expect(copyKinds.filter((kind) => kind === "duplicate").length).toBeLessThanOrEqual(1);
      expect(threads.get(canonicalRoot)).toEqual({ isResolved: false, receipts: [] });
      expect(
        controls.replies.filter((reply) => reply.body.includes("kind=duplicate")).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      await seeded.cleanup();
    }
  });
});
