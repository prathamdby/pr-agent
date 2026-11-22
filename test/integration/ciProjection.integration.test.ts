import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.ts";
import { runCiProjectionJob } from "../../src/agentWork/executors/ciProjectionExecutor.ts";
import { prResourceKey, type WebhookHeaders } from "../../src/agentWork/types.ts";
import { createFakePrSurface } from "../../src/github/prSurface.ts";
import {
  deniedInstallationCapabilities,
  unknownInstallationCapabilities,
} from "../../src/github/installationCapabilities.ts";
import type { CiSummaryAuthor } from "../../src/review/ci/ciAuthor.ts";
import {
  hashCiFacts,
  parseCiAuthoredCache,
  type CiCheckFact,
  type CiCheckRunSnapshot,
} from "../../src/review/ci/ciFacts.ts";
import {
  parseCiSummaryMarkerVersion,
  renderCiRollupMarker,
  renderCiSummaryCell,
} from "../../src/review/ci/ciSummaryCell.ts";
import {
  REVIEW_SUMMARY_SENTINEL,
  TRIAGE_SUMMARY_SENTINEL,
  VERIFICATION_PUBLISH_LENS,
} from "../../src/settings/index.ts";
import { createFeaturePublication, recordPublishStep } from "../../src/state/featurePublication.ts";
import {
  loadGithubCapabilityObservation,
  saveGithubCapabilityObservation,
} from "../../src/state/githubCapabilities.ts";
import { ensurePrState, runDelivery } from "../../src/state/intake.ts";
import {
  applyPrHeadCiFact,
  enqueueDueCiProjections,
  listProjectionRepairPendingHeads,
  loadHeadCiProjectionRow,
  loadPrHeadCiState,
  loadRenderableHeadCi,
  markProjectionRepairPending,
  refreshHeadCiFromSnapshot,
  requestHeadCiProjection,
  seedHeadCiFromSnapshot,
} from "../../src/state/prHeadCiState.ts";
import { openRateLimitCircuit } from "../../src/state/rateLimitCircuits.ts";
import { insertWorkRun, markWorkRunCompleted, workRunById } from "../../src/state/workRuns.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { openSqliteAppState } from "./db.ts";

const OWNER = "ci-projection-it";
const REPO = "app";
const PR_NUMBER = 7;
const INSTALLATION_ID = 9001;
const REPO_KEY = `${OWNER}/${REPO}`;
const PR_KEY = prResourceKey(OWNER, REPO, PR_NUMBER);
const cfg = makeTestConfig();

function headers(event: string, delivery: string) {
  return ((pinnedReturn: WebhookHeaders) => pinnedReturn)({
    event,
    delivery,
    rawBody: Buffer.from(JSON.stringify({ action: "completed", delivery })),
  });
}

function ciStateFact(overrides: Partial<CiCheckFact> = {}) {
  return ((pinnedReturn: CiCheckFact) => pinnedReturn)({
    name: "lint",
    source: "check_run",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/runs/1",
    external_id: null,
    app_id: 9,
    check_run_id: 77,
    observed_at: "2026-09-13T00:00:02.000Z",
    ...overrides,
  });
}

function checkRunSnapshot(
  overrides: Partial<CiCheckRunSnapshot> & Pick<CiCheckRunSnapshot, "id" | "name">,
) {
  return ((pinnedReturn: CiCheckRunSnapshot) => pinnedReturn)({
    status: "completed",
    conclusion: "success",
    htmlUrl: null,
    outputTitle: null,
    outputSummary: null,
    outputText: null,
    ...overrides,
  });
}

function reviewCommentBody(
  headSha: string,
  version: number,
  workItemId: string,
  options?: { readonly actionPhrase?: string },
) {
  const cell = renderCiSummaryCell(
    { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    headSha,
    version,
  );
  const action =
    options?.actionPhrase == null
      ? []
      : [
          "> [!NOTE]",
          `> No findings, ready to merge. <!-- pr-agent:ci-action fmt=1 -->${options.actionPhrase}<!-- /pr-agent:ci-action -->. All specialists ran with full coverage.`,
          "",
        ];
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      REVIEW_SUMMARY_SENTINEL,
      "",
      ...action,
      `<table><tr><td><strong>CI</strong></td><td>${cell}</td></tr></table>`,
      "",
      `<!-- pr-agent:review-meta headSha=${headSha} lens=review stale=false -->`,
      `<!-- pr-agent:progress-revision workItemId=${workItemId} value=1 -->`,
    ].join("\n"),
  );
}

function makePublicationForProjection(
  db: ReturnType<typeof openSqliteAppState>["db"],
  now: number,
  headSha = "any",
) {
  const workId = randomUUID();
  const prKey = `${OWNER}/${REPO}#ci:${headSha}`;
  ensurePrState(db, prKey, now);
  insertWorkRun(db, {
    workId,
    prKey,
    kind: "ci_projection",
    payloadJson: JSON.stringify({ owner: OWNER, repo: REPO, headSha }),
    now,
  });
  db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(workId);
  return createFeaturePublication({
    db,
    workId,
    prKey,
    laneEpoch: null,
    shutdownRequested: () => false,
    now: () => now,
  });
}

describe("CI projection on SQLite app_state (integration)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists projector runtime denial and makes the next caller skip denied publication", async () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const scope = { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO };
      saveGithubCapabilityObservation(state.db, {
        ...scope,
        observation: {
          generation: 1,
          capabilities: { pullRequestsRead: "available", commentsWrite: "available" },
        },
        now,
      });
      const installationSurface = openInstallationSurface();
      const create = vi.spyOn(installationSurface, "create").mockImplementation(async (params) => {
        await params.capabilities?.deny("commentsWrite");
        throw new Error("Resource not accessible by integration");
      });
      const deps = {
        db: state.db,
        cfg,
        installationSurface,
        publication: makePublicationForProjection(state.db, now),
        now: () => now,
      };
      const data = { kind: "ci_projection" as const, ...scope, headSha: "runtime-denial" };
      await expect(runCiProjectionJob(deps, data)).rejects.toThrow("Resource not accessible");
      expect(loadGithubCapabilityObservation(state.db, scope)?.capabilities.commentsWrite).toBe(
        "denied",
      );

      create.mockClear();
      await runCiProjectionJob(deps, { ...data });
      expect(create).not.toHaveBeenCalled();
    } finally {
      state.close();
    }
  });

  it("refreshes a stored observation that never confirmed access before reusing it", async () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const scope = { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO };
      const capabilityScope = { appId: cfg.github.appId, ...scope };
      saveGithubCapabilityObservation(state.db, {
        ...scope,
        observation: unknownInstallationCapabilities(capabilityScope, "1"),
        now,
      });
      const installationSurface = openInstallationSurface();
      const preflight = vi.spyOn(installationSurface, "preflight").mockResolvedValue({
        observation: deniedInstallationCapabilities(capabilityScope, "2"),
        installation: { token: "tok", expiresAtTs: now + 60_000, ttlMs: 60_000 },
      });
      const create = vi.spyOn(installationSurface, "create");
      const deps = {
        db: state.db,
        cfg,
        installationSurface,
        publication: makePublicationForProjection(state.db, now),
        now: () => now,
      };
      await runCiProjectionJob(deps, {
        kind: "ci_projection",
        ...scope,
        headSha: "capability-refresh",
      });
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(loadGithubCapabilityObservation(state.db, scope)).toMatchObject({
        generation: 2,
        capabilities: { pullRequestsRead: "denied", commentsWrite: "denied" },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      state.close();
    }
  });

  it("renders an unseeded head as waiting unless a CI source is denied", () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const headSha = "capability-unseeded";
      applyPrHeadCiFact(
        state.db,
        {
          installationId: INSTALLATION_ID,
          repoKey: REPO_KEY,
          headSha,
          fact: ciStateFact({ status: "in_progress", conclusion: null }),
        },
        now,
      );
      const scope = { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO };
      saveGithubCapabilityObservation(state.db, {
        ...scope,
        observation: {
          generation: 1,
          capabilities: { checksRead: "available", statusesRead: "available" },
        },
        now,
      });
      const waiting = loadRenderableHeadCi(state.db, { ...scope, headSha });
      expect(waiting).toEqual({
        summary: { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
        version: loadPrHeadCiState(state.db, { repoKey: REPO_KEY, headSha })?.state.version,
      });

      saveGithubCapabilityObservation(state.db, {
        ...scope,
        observation: {
          generation: 2,
          capabilities: { checksRead: "available", statusesRead: "denied" },
        },
        now: now + 10,
      });
      const denied = loadRenderableHeadCi(state.db, { ...scope, headSha });
      expect(denied.summary.headline).not.toBe("⏳ Waiting for CI");
      expect(denied.summary.permissionNote).toContain("Partial CI view");
    } finally {
      state.close();
    }
  });

  it("clears a repair flag the projector cannot act on while comment access is denied", async () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const headSha = "capability-repair-denied";
      seedHeadCiFromSnapshot(
        state.db,
        {
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo: REPO,
          headSha,
          checkRuns: [],
          legacyStatuses: [],
          githubAppId: cfg.github.appId,
        },
        now,
      );
      markProjectionRepairPending(state.db, { repoKey: REPO_KEY, headSha }, now);
      expect(listProjectionRepairPendingHeads(state.db, 100).map((h) => h.headSha)).toContain(
        headSha,
      );

      const scope = { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO };
      saveGithubCapabilityObservation(state.db, {
        ...scope,
        observation: {
          generation: 1,
          capabilities: { pullRequestsRead: "available", commentsWrite: "denied" },
        },
        now,
      });
      const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER });
      const createSurface = vi.fn(async () => fake.surface);
      await runCiProjectionJob(
        {
          db: state.db,
          cfg,
          installationSurface: openInstallationSurface(),
          publication: makePublicationForProjection(state.db, now),
          now: () => now,
        },
        { kind: "ci_projection", ...scope, headSha },
        { createSurface },
      );
      expect(createSurface).not.toHaveBeenCalled();
      expect(loadPrHeadCiState(state.db, { repoKey: REPO_KEY, headSha })?.repairPending).toBe(
        false,
      );
      expect(listProjectionRepairPendingHeads(state.db, 100).map((h) => h.headSha)).not.toContain(
        headSha,
      );
    } finally {
      state.close();
    }
  });

  it("defers projection when the installation rate limit circuit is open", async () => {
    const state = openSqliteAppState();
    try {
      const now = 1_700_000_000_000;
      const headSha = "rate-limited-head";
      openRateLimitCircuit(state.db, {
        installationId: INSTALLATION_ID,
        lastErrorKind: "secondary_rate_limit",
        cooldownMs: 30_000,
        now,
      });
      const createSurface = vi.fn(async () => {
        throw new Error("should not call GitHub while circuit is open");
      });
      await runCiProjectionJob(
        {
          db: state.db,
          cfg,
          installationSurface: openInstallationSurface(),
          publication: makePublicationForProjection(state.db, now),
          now: () => now,
        },
        {
          kind: "ci_projection",
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo: REPO,
          headSha,
        },
        { createSurface },
      );
      expect(createSurface).not.toHaveBeenCalled();
      const row = loadPrHeadCiState(state.db, { repoKey: REPO_KEY, headSha });
      expect(row?.nextProjectionAt).toBeGreaterThanOrEqual(now + 30_000);
    } finally {
      state.close();
    }
  });

  it("ingests ci_state webhooks, promotes due projections, caches CI authoring, patches review + triage comments, injects verification failure, and reconciles own verdicts", async () => {
    const state = openSqliteAppState();
    try {
      const now = 1_700_000_000_000;
      const headSha = "a".repeat(40);
      const reviewWorkId = randomUUID();
      ensurePrState(state.db, PR_KEY, now);
      insertWorkRun(state.db, {
        workId: reviewWorkId,
        prKey: PR_KEY,
        kind: "review",
        payloadJson: JSON.stringify({
          owner: OWNER,
          repo: REPO,
          prNumber: PR_NUMBER,
          headSha,
          mode: "review",
        }),
        now,
      });
      state.db
        .prepare(
          `INSERT INTO work_run_attempts (work_id, attempt_no, attempt_id, status, started_at)
           VALUES (?, 1, ?, 'running', ?)`,
        )
        .run(reviewWorkId, randomUUID(), now);
      state.db
        .prepare(
          `UPDATE work_runs SET status = 'running', current_attempt_no = 1 WHERE work_id = ?`,
        )
        .run(reviewWorkId);
      markWorkRunCompleted(state.db, { workId: reviewWorkId, attemptNo: 1, now: now + 1 });
      expect(workRunById(state.db, reviewWorkId)?.status).toBe("completed");

      recordPublishStep(state.db, {
        workId: reviewWorkId,
        prKey: PR_KEY,
        lens: VERIFICATION_PUBLISH_LENS,
        step: "verification_failure",
        detail: { headSha, active: true },
        now: now + 2,
      });

      const delivered = runDelivery(
        state.db,
        cfg,
        {
          kind: "ci_state",
          headers: headers("check_run", "deliv-ci-1"),
          data: {
            installationId: INSTALLATION_ID,
            owner: OWNER,
            repo: REPO,
            headSha,
            fact: ciStateFact({ name: "lint", status: "completed", conclusion: "failure" }),
          },
        },
        now + 5,
      );
      expect(delivered.events.map((event) => event.name)).toContain("ci_state_applied");

      const staleFact = applyPrHeadCiFact(
        state.db,
        {
          installationId: INSTALLATION_ID,
          repoKey: REPO_KEY,
          headSha,
          fact: ciStateFact({
            name: "lint",
            status: "completed",
            conclusion: "success",
            observed_at: "2026-09-13T00:00:01.000Z",
          }),
        },
        now + 6,
      );
      expect(staleFact.accepted).toBe(false);

      const pendingProjections = state.db
        .prepare(
          `SELECT work_id FROM work_runs WHERE kind = 'ci_projection' AND status = 'pending_dispatch'`,
        )
        .all();
      expect(pendingProjections).toHaveLength(1);

      const secondHead = "b".repeat(40);
      requestHeadCiProjection(
        state.db,
        { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO, headSha: secondHead },
        { kind: "debounced" },
        now + 5,
      );
      const enqueued = enqueueDueCiProjections(state.db, now + 10_000, 10);
      expect(enqueued).toHaveLength(1);
      requestHeadCiProjection(
        state.db,
        { installationId: INSTALLATION_ID, owner: OWNER, repo: REPO, headSha: secondHead },
        { kind: "debounced" },
        now + 10_000,
      );
      const deduped = enqueueDueCiProjections(state.db, now + 20_000, 10);
      expect(deduped).toHaveLength(0);

      const fake = createFakePrSurface(
        { owner: OWNER, repo: REPO, prNumber: PR_NUMBER },
        { headSha },
      );
      fake.controls.setPullsForHead(headSha, [{ number: PR_NUMBER }]);
      fake.controls.setCiStatus(headSha, {
        checkRuns: [
          checkRunSnapshot({
            id: 77,
            name: "lint",
            status: "completed",
            conclusion: "failure",
            outputTitle: "oxfmt failed",
          }),
          checkRunSnapshot({
            id: 78,
            name: "test",
            status: "completed",
            conclusion: "success",
          }),
        ],
        legacyStatuses: [],
      });
      await fake.surface.upsertProgressComment(
        reviewCommentBody(headSha, 0, reviewWorkId, { actionPhrase: "CI is still running" }),
        REVIEW_SUMMARY_SENTINEL,
        null,
      );
      await fake.surface.upsertProgressComment(
        `${TRIAGE_SUMMARY_SENTINEL}\n${renderCiRollupMarker(headSha, 0, "pending")}`,
        TRIAGE_SUMMARY_SENTINEL,
        null,
      );

      const authorCalls: unknown[] = [];
      const author: CiSummaryAuthor = async (input) => {
        authorCalls.push(input);
        return {
          headline: "❌ authored lint",
          failures: [{ name: "lint", reason: "oxfmt failed", fixHint: "run oxfmt" }],
        };
      };
      const repairedVerdicts: string[] = [];
      const reviewPublisher = {
        publish: vi.fn(),
        tickProgressSummary: vi.fn(),
        pendingVerdict: vi.fn(),
        closeCancelledVerdicts: vi.fn(),
        repairOwnVerdictIfOpen: vi.fn(async (params: { readonly workItemId: string }) => {
          repairedVerdicts.push(params.workItemId);
        }),
      };

      await runCiProjectionJob(
        {
          db: state.db,
          cfg,
          installationSurface: openInstallationSurface(),
          publication: makePublicationForProjection(state.db, now + 20_000, headSha),
          reviewPublisher,
          now: () => now + 20_000,
        },
        {
          kind: "ci_projection",
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo: REPO,
          headSha,
        },
        { createSurface: async () => fake.surface, author },
      );

      expect(authorCalls).toHaveLength(1);
      expect(repairedVerdicts).toEqual([reviewWorkId]);

      const reviewComment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
      expect(reviewComment?.body).toContain("❌ authored lint");
      expect(reviewComment?.body).toContain("Verification");
      expect(parseCiSummaryMarkerVersion(reviewComment?.body ?? "")).toBeGreaterThan(0);

      const triageComment = fake.controls.getProgressComment(TRIAGE_SUMMARY_SENTINEL);
      expect(triageComment?.body).toContain("-->failing<!-- /pr-agent:ci-rollup -->");

      const rowAfter = loadHeadCiProjectionRow(state.db, { owner: OWNER, repo: REPO, headSha });
      const cached = parseCiAuthoredCache(rowAfter?.authored);
      expect(cached?.factsHash).toBe(hashCiFacts(rowAfter?.checks ?? {}));

      await runCiProjectionJob(
        {
          db: state.db,
          cfg,
          installationSurface: openInstallationSurface(),
          publication: makePublicationForProjection(state.db, now + 25_000),
          now: () => now + 25_000,
        },
        {
          kind: "ci_projection",
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo: REPO,
          headSha,
        },
        { createSurface: async () => fake.surface, author },
      );
      expect(authorCalls).toHaveLength(1);

      const refreshed = refreshHeadCiFromSnapshot(
        state.db,
        {
          installationId: INSTALLATION_ID,
          owner: OWNER,
          repo: REPO,
          headSha,
          checkRuns: [
            checkRunSnapshot({ id: 77, name: "lint", status: "completed", conclusion: "success" }),
            checkRunSnapshot({ id: 78, name: "test", status: "completed", conclusion: "success" }),
          ],
          legacyStatuses: [],
          githubAppId: cfg.github.appId,
        },
        now + 30_000,
      );
      expect(refreshed.row.rollup).toBe("passing");
      expect(refreshed.row.version).toBeGreaterThan(rowAfter?.version ?? 0);
    } finally {
      state.close();
    }
  });
});
