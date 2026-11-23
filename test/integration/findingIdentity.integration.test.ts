import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { readRow, readRows } from "../../src/state/db.ts";
import { ensurePrState } from "../../src/state/intake.ts";
import { createFeaturePublication, publishIntentFor } from "../../src/state/featurePublication.ts";
import {
  createPublishMutationBoundary,
  reviewDuplicateOperationKey,
} from "../../src/state/publish.ts";
import { bumpLaneEpoch, cancelWorkRun, insertWorkRun } from "../../src/state/workRuns.ts";
import { renderObjectionAnswerMarker } from "../../src/review/findingIdentity/findingMarker.ts";
import {
  createFakePrSurface,
  withPrSurfaceMutationBoundary,
  type FakePrSurfaceControls,
  type PrSurface,
} from "../../src/github/prSurface.ts";
import { reviewVerdictSurfaces } from "../../src/review/publish/reviewVerdictSurfaces.ts";
import { publishVerification } from "../../src/agent/verification/publishVerification.ts";
import {
  loadFindingInventory,
  loadFindingInventoryFromThreads,
  type FindingInventory,
} from "../../src/review/findingIdentity/findingInventory.ts";
import {
  parseOwnedFindingMarker,
  parseOwnedReceipts,
  renderReceipt,
  type FindingId,
} from "../../src/review/findingIdentity/findingMarker.ts";
import { AppError } from "../../src/errors/appError.ts";
import { createOrchestratorPhaseRef } from "../../src/review/orchestrator/phaseToolPolicy.ts";
import { buildPublishThreadTool } from "../../src/review/orchestrator/publishThreadTool.ts";
import { candidateFindingId } from "../../src/review/orchestrator/judgmentDisposition.ts";
import type { SpecialistReport } from "../../src/review/orchestrator/specialistReport.ts";
import { buildDeclareDuplicateTool } from "../../src/review/orchestrator/declareDuplicateTool.ts";
import { fetchBotFindingThreads } from "../../src/review/run/reviewPriorFeedback.ts";
import { recordDeliveredFileRead } from "../../src/review/findings/evidenceLedger.ts";
import {
  createFindingLedger,
  type FindingLedger,
} from "../../src/review/orchestrator/orchestratorTypes.ts";
import { publishFindingBatch } from "../../src/review/publish/publishFindingBatch.ts";
import { createReviewPublishSession } from "../../src/review/publish/reviewPublishSession.ts";
import { publishReviewSummaryOnly } from "../../src/review/publish/publishSummaryOnly.ts";
import { reviewPayloadFromFindings, type ReviewFinding } from "../../src/review/reviewSchema.ts";
import type { ReviewPublishSession } from "../../src/review/publish/reviewPublishSession.ts";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../../src/review/statusCopy.ts";
import { makeTestConfig } from "../helpers/config.ts";
import {
  createTestEvidenceLedger,
  seedEvidenceForFindings,
} from "../helpers/evidenceTestHelpers.ts";
import {
  cachedDiffForFiles,
  cachedDiffForLines,
  completeFindingInventory,
} from "../helpers/reviewPublishTestHelpers.ts";
import { openSqliteAppState } from "./db.ts";

const HEAD_SHA = "abc1234";
const LEASE_EPOCH = 7;

const findings: readonly ReviewFinding[] = [10, 11].map((line) => ({
  severity: "P1",
  severityRationale: "The null read is reachable on this path.",
  file: "src/a.ts",
  startLine: line,
  endLine: line,
  title: `Null dereference at line ${line}`,
  detail: `The payload read at line ${line} can be null on this path.`,
  fixPrompt: "Guard the payload before dereferencing it.",
}));

describe("finding identity (integration)", () => {
  let state: ReturnType<typeof openSqliteAppState>;
  let db: DatabaseSync;

  beforeAll(() => {
    state = openSqliteAppState();
    db = state.db;
  });

  afterAll(() => {
    state.close();
  });

  const rerunCleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of rerunCleanups.splice(0)) await cleanup();
  });

  function makePublication(workItemId: string, resourceKey: string) {
    return createFeaturePublication({
      db,
      workId: workItemId,
      prKey: resourceKey,
      laneEpoch: LEASE_EPOCH,
      shutdownRequested: () => false,
    });
  }

  async function seedReviewPublication(cfg = makeTestConfig()) {
    const workItemId = randomUUID();
    const repo = `r-${workItemId}`;
    const resourceKey = `finding-identity-it/${repo}#1`;
    const now = Date.now();
    ensurePrState(db, resourceKey, now);
    db.prepare(
      `UPDATE pr_state SET auto_review_epoch = ?, verification_epoch = ?, updated_at = ? WHERE pr_key = ?`,
    ).run(LEASE_EPOCH, LEASE_EPOCH, now, resourceKey);
    insertWorkRun(db, {
      workId: workItemId,
      prKey: resourceKey,
      kind: "review",
      laneEpoch: LEASE_EPOCH,
      payloadJson: JSON.stringify({ headSha: HEAD_SHA }),
      now,
    });
    db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(workItemId);
    const { surface, controls } = createFakePrSurface({
      owner: "finding-identity-it",
      repo,
      prNumber: 1,
    });

    const attempt = (
      _client: DatabaseSync,
      prSurface: PrSurface,
      observations: readonly ReviewFinding[] = [],
      findingInventory: FindingInventory = completeFindingInventory(),
      extra?: {
        readonly diff?: ReturnType<typeof cachedDiffForLines>;
        readonly evidence?: readonly ReviewFinding[];
        readonly reads?: readonly {
          readonly path: string;
          readonly startLine: number;
          readonly endLine: number;
          readonly content: string;
        }[];
      },
    ) => {
      const evidenceLedger = createTestEvidenceLedger(HEAD_SHA);
      seedEvidenceForFindings(evidenceLedger, [
        ...findings,
        ...observations,
        ...(extra?.evidence ?? []),
      ]);
      recordDeliveredFileRead(evidenceLedger, {
        path: "src/a.ts",
        headSha: HEAD_SHA,
        tool: "readWorkspaceFile",
        startLine: 10,
        endLine: 11,
        content: "line ten\nline eleven",
      });
      for (const read of extra?.reads ?? []) {
        recordDeliveredFileRead(evidenceLedger, {
          path: read.path,
          headSha: HEAD_SHA,
          tool: "readWorkspaceFile",
          startLine: read.startLine,
          endLine: read.endLine,
          content: read.content,
        });
      }
      const session = createReviewPublishSession({
        cfg,
        ctx: {
          owner: "finding-identity-it",
          repo,
          prNumber: 1,
          headSha: HEAD_SHA,
        },
        workItemId,
        publish: { db, workItemId, resourceKey, laneEpoch: LEASE_EPOCH },
        prSurface,
        findingInventory,
        cachedDiffIndex: extra?.diff ?? cachedDiffForLines("src/a.ts", [10, 11]),
        resolveProgressCommentUrl: async () =>
          `https://github.com/finding-identity-it/${repo}/pull/1#issuecomment-99`,
      });
      return {
        session,
        input: { source: "correctness" as const, ledger: createFindingLedger(), evidenceLedger },
      };
    };

    const cleanup = async () => {
      db.prepare("DELETE FROM publish_intents WHERE work_id = ?").run(workItemId);
      db.prepare("DELETE FROM publish_records WHERE work_id = ?").run(workItemId);
      db.prepare("DELETE FROM work_runs WHERE work_id = ?").run(workItemId);
      db.prepare("DELETE FROM pr_state WHERE pr_key = ?").run(resourceKey);
    };

    return { workItemId, resourceKey, surface, controls, attempt, cleanup };
  }

  async function rerun(
    surface: PrSurface,
    observations: readonly ReviewFinding[] = [],
    findingInventory?: FindingInventory,
    cfg = makeTestConfig(),
  ) {
    const next = await seedReviewPublication(cfg);
    rerunCleanups.push(next.cleanup);
    return {
      ...next.attempt(db, surface, observations, findingInventory),
      workItemId: next.workItemId,
      resourceKey: next.resourceKey,
    };
  }

  async function publishSummaryWithVerdict(
    surface: PrSurface,
    run: Awaited<ReturnType<typeof rerun>>,
    ledger: FindingLedger,
  ) {
    await reviewVerdictSurfaces({
      target: {
        db,
        workItemId: run.workItemId,
        resourceKey: run.resourceKey,
        laneEpoch: LEASE_EPOCH,
      },
      prSurface: surface,
      owner: "finding-identity-it",
      repo: surface.repo,
      prNumber: 1,
      reviewLens: "review",
      headSha: HEAD_SHA,
      commitStatusEnabled: false,
    }).pending();
    return publishReviewSummaryOnly(run.session, {
      payload: reviewPayloadFromFindings([]),
      ledger,
    });
  }

  function lastSummaryBody(controls: FakePrSurfaceControls) {
    const upserts = controls.events.flatMap((event) =>
      event.kind === "upsertProgressComment" ? [event.body] : [],
    );
    return ((pinnedReturn: string) => pinnedReturn)(upserts.at(-1) ?? "");
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

  function openIdAt(inventory: FindingInventory, line: number) {
    const match = [...inventory.findings.values()].find(
      (entry) => entry.state === "open" && entry.line === line,
    );
    if (match == null) throw new Error(`expected an open finding at line ${line}`);
    return ((pinnedReturn: FindingId) => pinnedReturn)(match.id);
  }

  function judgmentPayload(source: "correctness" | "security", rows: readonly ReviewFinding[]) {
    const byId = new Map<
      string,
      { candidateId: string; verdict: "accepted"; reason: "confirmed" }
    >();
    for (const row of rows) {
      const candidateId = candidateFindingId({
        specialist: source,
        file: row.file,
        startLine: row.startLine,
        endLine: row.endLine,
        title: row.title,
      });
      byId.set(candidateId, { candidateId, verdict: "accepted", reason: "confirmed" });
    }
    return { findings: rows, dispositions: [...byId.values()] };
  }

  function armReport(
    tool: { setReport: (report: SpecialistReport) => void },
    rows: readonly ReviewFinding[],
  ) {
    tool.setReport({
      status: "findings",
      findings: rows.map((row) => ({
        suggestedSeverity: row.severity,
        file: row.file,
        startLine: row.startLine,
        endLine: row.endLine,
        title: row.title,
        detail: row.detail,
        fixPrompt: row.fixPrompt,
      })),
    });
  }

  function observed(line: number, extras: Partial<ReviewFinding> = {}) {
    return ((pinnedReturn: ReviewFinding) => pinnedReturn)({
      severity: "P1",
      severityRationale: "The null read is reachable on this path.",
      file: "src/a.ts",
      startLine: line,
      endLine: line,
      title: `Payload can be null near line ${line}`,
      detail: `A null payload reaches the dereference near line ${line}.`,
      fixPrompt: "Check the payload for null first.",
      ...extras,
    });
  }

  async function publishFirstRound(seeded: Awaited<ReturnType<typeof seedReviewPublication>>) {
    const first = seeded.attempt(db, seeded.surface);
    const published = await publishFindingBatch(findings, first.session, first.input);
    if (published.kind !== "published") throw new Error("expected the first round to publish");
    const [reviewId] = published.delta.inlineReviewIds;
    if (reviewId == null) throw new Error("expected an inline review");
    return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(reviewId);
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
  ) {
    const first = seeded.attempt(db, seeded.surface, copies);
    const published = await publishFindingBatch(copies, first.session, first.input);
    if (published.kind !== "published") throw new Error("expected the copies to publish");
    const [reviewId] = published.delta.inlineReviewIds;
    if (reviewId == null) throw new Error("expected an inline review");
    const inventory = await loadFindingInventory(seeded.surface, noPathChanges);
    const ids = [...inventory.findings.values()]
      .filter((entry) => entry.state === "open" && entry.line === 10)
      .map((entry) => entry.id);
    if (ids.length !== copies.length) throw new Error("expected one open thread per copy");
    return ((
      pinnedReturn:
        | { readonly reviewId: number; readonly ids: readonly FindingId[] }
        | Promise<{ readonly reviewId: number; readonly ids: readonly FindingId[] }>,
    ) => pinnedReturn)({ reviewId, ids });
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

  it("rebuilds the same finding ids from GitHub after database loss and posts no duplicate", async () => {
    const { workItemId, surface, controls, attempt, cleanup } = await seedReviewPublication();

    try {
      const first = attempt(db, surface);
      const published = await publishFindingBatch(findings, first.session, first.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const recordedIds = published.delta.accepted.flatMap((entry) =>
        entry.kind === "posted" ? [entry.findingId] : [],
      );
      expect(recordedIds).toHaveLength(findings.length);
      const durableRows = () =>
        readRow(
          db
            .prepare(
              `SELECT (SELECT count(*) FROM publish_records WHERE work_id = ?)
                    + (SELECT count(*) FROM publish_intents WHERE work_id = ?) AS count`,
            )
            .get(workItemId, workItemId),
          v.object({ count: v.number() }),
        )?.count ?? 0;
      expect(durableRows()).toBeGreaterThan(0);

      await cleanup();
      expect(durableRows()).toBe(0);

      const inventory = await loadFindingInventory(surface, noPathChanges);
      expect(inventory.completeness).toBe("complete");
      const open = [...inventory.findings.values()].filter((finding) => finding.state === "open");
      expect(open.every((finding) => !finding.legacy)).toBe(true);
      expect(new Set(open.map((finding) => finding.id))).toEqual(new Set(recordedIds));
      expect(new Set(open.map((finding) => finding.line))).toEqual(new Set([10, 11]));

      const batchesBefore = controls.threadBatches.length;
      const tool = threadTool(await rerun(surface), inventory);
      const continued = findings.map((finding) => ({
        ...finding,
        relation: { kind: "continues" as const, findingId: openIdAt(inventory, finding.startLine) },
      }));
      armReport(tool, continued);
      const result = await tool.executor(judgmentPayload("correctness", continued));
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
      const first = attempt(db, surface);
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
        const found = (
          await fetchBotFindingThreads(surface, {
            botUserId,
            botLogin,
            inventory,
            publishRecordLenses: new Map([[reviewId, "review" as const]]),
          })
        ).threads;
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
        publication: makePublication(workItemId, resourceKey),
        workItemId,
        resourceKey,
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
        publication: makePublication(workItemId, resourceKey),
        workItemId,
        resourceKey,
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

      const sameRows = [
        { ...reworded, relation: { kind: "continues" as const, findingId: lineTen } },
        { ...moved, relation: { kind: "continues" as const, findingId: lineEleven } },
      ];
      armReport(tool, sameRows);
      const sameLens = await tool.executor(judgmentPayload("correctness", sameRows));
      tool.setSource("security");
      const crossRows = [
        { ...otherLens, relation: { kind: "continues" as const, findingId: lineTen } },
      ];
      armReport(tool, crossRows);
      const crossLens = await tool.executor(judgmentPayload("security", crossRows));

      const renamed = observed(10, { file: "src/b.ts" });
      const renamedInventory = await loadFindingInventory(surface, {
        renames: new Map([["src/a.ts", "src/b.ts"]]),
        deletedPaths: new Set(),
      });
      const renamedTool = threadTool(await rerun(surface, [renamed]), renamedInventory);
      const renamedRows = [
        { ...renamed, relation: { kind: "continues" as const, findingId: lineTen } },
      ];
      armReport(renamedTool, renamedRows);
      const afterRename = await renamedTool.executor(judgmentPayload("correctness", renamedRows));

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

      armReport(tool, [nearby]);
      const asked = await tool.executor(judgmentPayload("correctness", [nearby])).then(
        () => null,
        (error: unknown) => error,
      );
      expect(asked).toBeInstanceOf(AppError);
      if (!(asked instanceof AppError)) return;
      expect(asked.code).toBe("review.publish_thread_overlap_unanswered");
      expect(asked.message).toContain(lineTen);
      expect(controls.threadBatches).toHaveLength(batchesBefore);

      const held = await tool.executor(judgmentPayload("correctness", [nearby]));
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

      const reopenedRows = [
        { ...regressed, relation: { kind: "continues" as const, findingId: fixedId } },
        { ...repeated, relation: { kind: "continues" as const, findingId: dismissedId } },
      ];
      armReport(tool, reopenedRows);
      const result = await tool.executor(judgmentPayload("correctness", reopenedRows));

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
      const reaffirmedRows = [
        { ...reaffirmed, relation: { kind: "continues" as const, findingId: lineTen } },
      ];
      armReport(tool, reaffirmedRows);
      await tool.executor(judgmentPayload("correctness", reaffirmedRows));
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

  it("fails only findings at or above the configured threshold and fails the check when a specialist did not finish", async () => {
    const cfg = makeTestConfig({ review: { checkFailSeverity: "P1" } });
    const seeded = await seedReviewPublication(cfg);
    const { surface, controls } = seeded;
    const quietFinding = observed(10, {
      severity: "P2",
      title: "Bounded gap in the null guard",
    });
    const blockingFinding = observed(11, {
      severity: "P0",
      title: "Reachable null write drops the record",
    });

    try {
      const first = seeded.attempt(db, surface, [quietFinding]);
      const published = await publishFindingBatch([quietFinding], first.session, first.input);
      if (published.kind !== "published") throw new Error("expected the P2 finding to publish");

      const quietInventory = await loadFindingInventory(surface, noPathChanges);
      const quietRun = await rerun(surface, [], quietInventory, cfg);
      const quietResult = await publishSummaryWithVerdict(surface, quietRun, quietRun.input.ledger);
      expect(quietResult).toMatchObject({
        kind: "published",
        check: { conclusion: "success", blockingCount: 0 },
      });
      expect(lastSummaryBody(controls)).toContain("1 open finding, none blocks merge");

      controls.setThreadResolutionStatus("partial", "thread page missing");
      const incompleteQuiet = await loadFindingInventory(surface, noPathChanges);
      expect(incompleteQuiet.completeness).toBe("partial");
      const incompleteQuietRun = await rerun(surface, [], incompleteQuiet, cfg);
      const incompleteQuietResult = await publishSummaryWithVerdict(
        surface,
        incompleteQuietRun,
        incompleteQuietRun.input.ledger,
      );
      expect(incompleteQuietResult).toMatchObject({
        kind: "published",
        check: { conclusion: "neutral", blockingCount: 0 },
      });

      controls.setThreadResolutionStatus("ok");
      const blockingRun = await rerun(surface, [blockingFinding], quietInventory, cfg);
      const blockingPublished = await publishFindingBatch(
        [blockingFinding],
        blockingRun.session,
        blockingRun.input,
      );
      if (blockingPublished.kind !== "published") {
        throw new Error("expected the P0 finding to publish");
      }
      const carried = await loadFindingInventory(surface, noPathChanges);
      const carriedRun = await rerun(surface, [], carried, cfg);
      const carriedResult = await publishSummaryWithVerdict(
        surface,
        carriedRun,
        carriedRun.input.ledger,
      );
      expect(carriedResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 1 },
      });

      controls.setThreadResolutionStatus("partial", "thread page missing");
      const incompleteBlocked = await loadFindingInventory(surface, noPathChanges);
      expect(incompleteBlocked.completeness).toBe("partial");
      const incompleteBlockedRun = await rerun(surface, [], incompleteBlocked, cfg);
      const incompleteBlockedResult = await publishSummaryWithVerdict(
        surface,
        incompleteBlockedRun,
        incompleteBlockedRun.input.ledger,
      );
      expect(incompleteBlockedResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 1 },
      });

      controls.setThreadResolutionStatus("ok");
      const partialInventory = await loadFindingInventory(surface, noPathChanges);
      const partialRun = await rerun(surface, [], partialInventory, cfg);
      await reviewVerdictSurfaces({
        target: {
          db,
          workItemId: partialRun.workItemId,
          resourceKey: partialRun.resourceKey,
          laneEpoch: LEASE_EPOCH,
        },
        prSurface: surface,
        owner: "finding-identity-it",
        repo: surface.repo,
        prNumber: 1,
        reviewLens: "review",
        headSha: HEAD_SHA,
        commitStatusEnabled: false,
      }).pending();
      const partialResult = await publishReviewSummaryOnly(partialRun.session, {
        payload: reviewPayloadFromFindings([]),
        ledger: partialRun.input.ledger,
        coverage: {
          kind: "partial",
          failed: ["tests"],
          note: "The tests specialist did not finish.",
        },
      });
      expect(partialResult).toMatchObject({
        kind: "published",
        check: { conclusion: "failure", blockingCount: 1 },
      });
      expect(checkConclusions(controls)).toEqual([
        "success",
        "neutral",
        "failure",
        "failure",
        "failure",
      ]);
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
        expect(publishIntentFor(db, run.workItemId, operationKey)?.state).toBe("reconciled");
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

      const attempts = [0, 1].map(() => seeded.attempt(db, surface, [], inventory));
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
      const verificationThreads = (
        await fetchBotFindingThreads(surface, {
          botUserId,
          inventory,
          publishRecordLenses: new Map([[reviewId, "review" as const]]),
        })
      ).threads;

      await Promise.all([
        ...attempts.map((attempt) => attempt.session.duplicateCleanup.clean(attempt.session)),
        publishVerification({
          publication: makePublication(workItemId, resourceKey),
          workItemId,
          resourceKey,
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

  it("serializes an objection answer with a concurrent receipt on the same thread", async () => {
    const seeded = await seedReviewPublication();
    const { workItemId, resourceKey, surface, controls } = seeded;
    const botUserId = 4242;
    const replyAt = "2026-01-02T14:32:47Z";
    const rootAt = "2026-01-01T14:00:00Z";

    try {
      const { reviewId, ids } = await publishCopies(seeded, lineTenCopies.slice(0, 2));
      controls.setReviewComments(
        (await surface.listReviewComments()).comments.map((comment) => ({
          ...comment,
          userId: botUserId,
          authorType: "Bot",
          createdAt: comment.createdAt ?? rootAt,
          updatedAt: comment.updatedAt ?? rootAt,
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
      const attempts = [0, 1].map(() => seeded.attempt(db, surface, [], inventory));
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
      if (copyRoot == null) throw new Error("expected the copy root");
      const objectionCommentId = 880_001;
      controls.setReviewComments([
        ...(await surface.listReviewComments()).comments,
        {
          id: objectionCommentId,
          inReplyToId: copyRoot,
          pullRequestReviewId: null,
          userId: 7,
          authorLogin: "maintainer",
          authorAssociation: "MEMBER",
          authorType: "User",
          createdAt: replyAt,
          updatedAt: replyAt,
          body: "The null check already exists on this branch.",
          path: null,
          line: null,
          originalLine: null,
          htmlUrl: "",
        },
      ]);
      const verificationThreads = (
        await fetchBotFindingThreads(surface, {
          botUserId,
          botLogin: await surface.getBotLogin(),
          inventory,
          publishRecordLenses: new Map([[reviewId, "review" as const]]),
        })
      ).threads;
      expect(
        verificationThreads
          .find((thread) => thread.rootCommentId === copyRoot)
          ?.objections?.some((candidate) => candidate.commentId === objectionCommentId),
      ).toBe(true);
      const listed = await surface.listInlineReviewThreads();

      await Promise.all([
        ...attempts.map((attempt) => attempt.session.duplicateCleanup.clean(attempt.session)),
        publishVerification({
          publication: makePublication(workItemId, resourceKey),
          workItemId,
          resourceKey,
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
            objectionDecisions: [
              {
                decision: "concede",
                commentId: objectionCommentId,
                updatedAt: replyAt,
                body: "The null check is on this branch.",
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
      const answers = controls.replies.filter((reply) =>
        reply.body.includes(renderObjectionAnswerMarker(objectionCommentId, replyAt)),
      );
      expect(answers).toHaveLength(1);
      expect(answers[0]?.body).toContain("abcdef1");
    } finally {
      await seeded.cleanup();
    }
  });

  it("reconciles one objection answer after GitHub accepts it and the journal write does not", async () => {
    const seeded = await seedReviewPublication();
    const { workItemId, resourceKey, surface, controls } = seeded;
    const botUserId = 4242;
    const replyAt = "2026-01-02T14:32:47Z";
    const rootAt = "2026-01-01T14:00:00Z";

    try {
      const { reviewId, ids } = await publishCopies(seeded, lineTenCopies.slice(0, 1));
      controls.setReviewComments(
        (await surface.listReviewComments()).comments.map((comment) => ({
          ...comment,
          userId: botUserId,
          authorType: "Bot",
          createdAt: comment.createdAt ?? rootAt,
          updatedAt: comment.updatedAt ?? rootAt,
        })),
      );
      controls.setPullRequestReviews(
        (await surface.listPullRequestReviews()).map((review) => ({
          ...review,
          userId: botUserId,
        })),
      );
      const inventory = await loadFindingInventory(surface, noPathChanges);
      const findingId = ids[0];
      if (findingId == null) throw new Error("expected one finding");
      const rootCommentId = inventory.findings.get(findingId)?.rootCommentId;
      if (rootCommentId == null) throw new Error("expected the finding root");
      const objectionCommentId = 880_002;
      controls.setReviewComments([
        ...(await surface.listReviewComments()).comments,
        {
          id: objectionCommentId,
          inReplyToId: rootCommentId,
          pullRequestReviewId: null,
          userId: 7,
          authorLogin: "maintainer",
          authorAssociation: "MEMBER",
          authorType: "User",
          createdAt: replyAt,
          updatedAt: replyAt,
          body: "This was fixed in the latest push.",
          path: null,
          line: null,
          originalLine: null,
          htmlUrl: "",
        },
      ]);
      const verificationThreads = (
        await fetchBotFindingThreads(surface, {
          botUserId,
          botLogin: await surface.getBotLogin(),
          inventory,
          publishRecordLenses: new Map([[reviewId, "review" as const]]),
        })
      ).threads;
      const listed = await surface.listInlineReviewThreads();
      const publish = {
        publication: makePublication(workItemId, resourceKey),
        workItemId,
        resourceKey,
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
              verdict: "fixed" as const,
              threadRootCommentId: rootCommentId,
              evidence: "guarded",
              commitSha: "abcdef1",
            },
          ],
          objectionDecisions: [
            {
              decision: "concede" as const,
              commentId: objectionCommentId,
              updatedAt: replyAt,
              body: "The null check is on this branch.",
            },
          ],
        },
        changedFilePaths: ["src/a.ts"],
        policyResult: { kind: "absent" as const },
      };
      controls.acceptThenRejectNextInlineReviewReply(new Error("lost after accept"));

      try {
        await publishVerification(publish);
      } catch (error) {
        expect(error).not.toMatchObject({ code: "agent_work.thread_mutation_lock_timeout" });
        throw error;
      }
      expect(
        controls.replies.filter((reply) =>
          reply.body.includes(renderObjectionAnswerMarker(objectionCommentId, replyAt)),
        ),
      ).toHaveLength(1);

      await publishVerification(publish);

      expect(
        controls.replies.filter((reply) =>
          reply.body.includes(renderObjectionAnswerMarker(objectionCommentId, replyAt)),
        ),
      ).toHaveLength(1);
      expect((await receiptsByThread(surface)).get(rootCommentId)?.isResolved).toBe(true);
    } finally {
      await seeded.cleanup();
    }
  });

  function reviewAnchorError(
    summary: string,
    entries: readonly { readonly message: string; readonly path: string; readonly line?: number }[],
  ) {
    return Object.assign(new Error(summary), {
      status: 422,
      response: {
        status: 422,
        data: {
          message: "Validation Failed",
          errors: entries.map((entry) => ({
            resource: "PullRequestReview",
            code: "custom",
            message: entry.message,
            path: entry.path,
            ...(entry.line != null ? { line: entry.line } : {}),
          })),
        },
      },
    });
  }

  function intentRows(workItemId: string) {
    return readRows(
      db
        .prepare(
          `SELECT operation_key, mutation_kind, state, identity_json
             FROM publish_intents
            WHERE work_id = ?
            ORDER BY updated_at, operation_key`,
        )
        .all(workItemId),
      v.object({
        operation_key: v.string(),
        mutation_kind: v.string(),
        state: v.string(),
        identity_json: v.string(),
      }),
    );
  }

  it("degrades a path-only rejection and keeps the usable finding", async () => {
    const seeded = await seedReviewPublication();
    const lineRejected: ReviewFinding = {
      ...findings[1],
      file: "src/c.ts",
      startLine: 2,
      endLine: 2,
      title: "Null dereference at line 2",
    };
    const pathRejected: ReviewFinding = {
      ...findings[1],
      file: "src/b.ts",
      startLine: 4,
      endLine: 4,
      title: "Null dereference at line 4",
    };
    const usable = findings[0];
    const batch = [lineRejected, pathRejected, usable];
    const responses: string[] = [];
    try {
      const original = seeded.surface.publishThreadBatch.bind(seeded.surface);
      vi.spyOn(seeded.surface, "publishThreadBatch").mockImplementation(async (review) => {
        responses.push(
          review.comments?.map((comment) => `${comment.path}:${comment.line}`).join(",") ?? "",
        );
        const attempt = responses.length;
        if (attempt === 1) {
          throw reviewAnchorError("Line could not be resolved and Path could not be resolved", [
            {
              message: "Line could not be resolved",
              path: "src/c.ts",
              line: 2,
            },
            { message: "Path could not be resolved", path: "src/c.ts" },
          ]);
        }
        if (attempt === 2) {
          throw reviewAnchorError("Path could not be resolved", [
            { message: "Path could not be resolved", path: "src/b.ts" },
          ]);
        }
        return original(review);
      });
      const boundary = createPublishMutationBoundary({
        db,
        workId: seeded.workItemId,
        prKey: seeded.resourceKey,
        laneEpoch: LEASE_EPOCH,
        signal: new AbortController().signal,
      });
      const wrapped = withPrSurfaceMutationBoundary(seeded.surface, boundary);
      const run = seeded.attempt(db, wrapped, [], completeFindingInventory(), {
        diff: cachedDiffForFiles([
          { file: "src/a.ts", lines: [10] },
          { file: "src/b.ts", lines: [4] },
          { file: "src/c.ts", lines: [2] },
        ]),
        evidence: [lineRejected, pathRejected],
        reads: [
          { path: "src/b.ts", startLine: 4, endLine: 4, content: "bad path" },
          { path: "src/c.ts", startLine: 2, endLine: 2, content: "bad line" },
        ],
      });
      const published = await publishFindingBatch(batch, run.session, run.input);
      expect(published.kind).toBe("published");
      if (published.kind !== "published") return;
      const posted = published.delta.accepted.filter((entry) => entry.kind === "posted");
      const summary = published.delta.accepted.filter(
        (entry) => entry.kind === "summary_only" && entry.reason === "anchor",
      );
      expect(posted.map((entry) => entry.placement.finding.file)).toEqual(["src/a.ts"]);
      expect(summary.map((entry) => entry.placement.finding.file).toSorted()).toEqual([
        "src/b.ts",
        "src/c.ts",
      ]);
      expect(seeded.controls.threadBatches).toHaveLength(1);
      expect(seeded.surface.publishThreadBatch).toHaveBeenCalledTimes(3);

      const again = await publishFindingBatch(batch, run.session, {
        ...run.input,
        ledger: createFindingLedger(),
      });
      expect(again.kind).toBe("published");
      expect(seeded.controls.threadBatches).toHaveLength(1);
      expect(seeded.surface.publishThreadBatch).toHaveBeenCalledTimes(3);

      const intents = intentRows(seeded.workItemId);
      const surfaceIntents = intents.filter((row) =>
        row.mutation_kind.includes("publishThreadBatch"),
      );
      expect(surfaceIntents.filter((row) => row.state === "mutation_failed")).toHaveLength(2);
      expect(surfaceIntents.filter((row) => row.state === "reconciled")).toHaveLength(1);
      expect(surfaceIntents.some((row) => row.state.startsWith("outcome_unknown"))).toBe(false);
      expect(intents.find((row) => row.mutation_kind === "github.inline_review")?.state).toBe(
        "reconciled",
      );
      const comments = (await seeded.surface.listReviewComments()).comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
      }));
      const artifact = {
        providerResponses: responses,
        remoteMutations: responses.length,
        acceptedReviewCount: seeded.controls.threadBatches.length,
        intents: intents.map((row) => ({
          operationKey: row.operation_key,
          mutationKind: row.mutation_kind,
          state: row.state,
        })),
        visibleFindings: {
          posted: posted.map((entry) => ({
            id: entry.findingId,
            file: entry.placement.finding.file,
            line: entry.placement.finding.startLine,
          })),
          summaryOnly: summary.map((entry) => ({
            id: entry.findingId,
            file: entry.placement.finding.file,
            line: entry.placement.finding.startLine,
          })),
        },
        reviewComments: comments,
      };
      writeFileSync(
        join(tmpdir(), `inline-publish-degrade-${seeded.workItemId}.json`),
        JSON.stringify(artifact, null, 2),
      );
      expect(artifact.remoteMutations).toBe(3);
      expect(
        artifact.intents.filter((row) => row.state === "mutation_failed").length,
      ).toBeGreaterThan(0);
    } finally {
      await seeded.cleanup();
    }
  });

  it("does not remutate an ambiguous 422 or a bare path message", async () => {
    for (const rejection of [
      Object.assign(new Error("Validation Failed"), {
        status: 422,
        response: { status: 422, data: { message: "Server busy; please try again" } },
      }),
      new Error("Path could not be resolved"),
    ]) {
      const seeded = await seedReviewPublication();
      try {
        vi.spyOn(seeded.surface, "publishThreadBatch").mockImplementation(async () => {
          throw rejection;
        });
        const boundary = createPublishMutationBoundary({
          db,
          workId: seeded.workItemId,
          prKey: seeded.resourceKey,
          laneEpoch: LEASE_EPOCH,
          signal: new AbortController().signal,
        });
        const wrapped = withPrSurfaceMutationBoundary(seeded.surface, boundary);
        const run = seeded.attempt(db, wrapped);
        await expect(publishFindingBatch(findings, run.session, run.input)).rejects.toThrow();
        expect(seeded.surface.publishThreadBatch).toHaveBeenCalledTimes(1);
        const first = intentRows(seeded.workItemId);
        expect(first.some((row) => row.state.startsWith("outcome_unknown"))).toBe(true);
        expect(first.some((row) => row.state === "mutation_failed")).toBe(false);
        await expect(
          publishFindingBatch(findings, run.session, {
            ...run.input,
            ledger: createFindingLedger(),
          }),
        ).rejects.toThrow();
        expect(seeded.surface.publishThreadBatch).toHaveBeenCalledTimes(1);
        expect(seeded.controls.threadBatches).toHaveLength(0);
      } finally {
        await seeded.cleanup();
      }
    }
  });

  it("stops the fallback when the lane epoch advances or the run is cancelled", async () => {
    const cases = ["epoch", "cancel"] as const;
    for (const stop of cases) {
      const seeded = await seedReviewPublication();
      try {
        vi.spyOn(seeded.surface, "publishThreadBatch").mockImplementation(async () => {
          if (stop === "epoch") {
            bumpLaneEpoch(db, { prKey: seeded.resourceKey, lane: "review", now: Date.now() });
          } else {
            cancelWorkRun(db, {
              workId: seeded.workItemId,
              reason: "cancelled",
              now: Date.now(),
            });
          }
          throw reviewAnchorError("Path could not be resolved", [
            { message: "Path could not be resolved", path: "src/a.ts", line: 10 },
          ]);
        });
        const boundary = createPublishMutationBoundary({
          db,
          workId: seeded.workItemId,
          prKey: seeded.resourceKey,
          laneEpoch: LEASE_EPOCH,
          signal: new AbortController().signal,
        });
        const wrapped = withPrSurfaceMutationBoundary(seeded.surface, boundary);
        const run = seeded.attempt(db, wrapped);
        const error = await publishFindingBatch([findings[0]], run.session, run.input).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({
          code: "operation_intent.mutation_gate_failed",
        });
        expect(seeded.controls.threadBatches).toHaveLength(0);
        expect(seeded.surface.publishThreadBatch).toHaveBeenCalledTimes(1);
      } finally {
        await seeded.cleanup();
      }
    }
  });
});
