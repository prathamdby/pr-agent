import { createDurableRuntime } from "../../src/agentWork/durableJob.js";
import { createWorkDefinitions } from "../../src/agentWork/workDefinition.js";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.js";
import type { PrSurfaceMutation } from "../../src/github/prSurface.js";
import type { DescriptionPayload } from "../../src/agent/description/descriptionSchema.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  loadReviewExecutorPublishContext,
  recordPublishStep,
  recordReviewCheckRun,
} from "../../src/agentWork/repository.js";
import { retryDispositionFor } from "../../src/agentWork/retryPolicy.js";
import { AppError } from "../../src/errors/appError.js";
import type { ReviewJobData } from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import {
  claimSummaryCommentCreation,
  ownVerdictCloseOperationKey,
  recordAskPublishStep,
  type PublishStep,
} from "../../src/agentWork/publishRecordRepository.js";
import { saveVerificationThreadLedger } from "../../src/agentWork/verificationThreadLedger.js";
import { WORKER_CONSUMER_QUEUES, WORKER_DLQ_QUEUES } from "../../src/agentWork/workerHealth.js";
import * as analytics from "../../src/analytics/index.js";
import * as evlog from "../../src/evlog.js";
import {
  captureCiStateChanged,
  captureDurableWorkCompleted,
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
import { withProgressRevisionComment } from "../../src/review/run/progressComment.js";
import {
  renderReviewPointerLensMarker,
  renderStaleReviewMetadataComment,
} from "../../src/review/run/reviewRender.js";
import { renderCiRollupMarker } from "../../src/review/ci/ciRollupMarker.js";
import { renderCiActionPhrase } from "../../src/review/ci/ciSummaryCell.js";
import { renderCiSummaryCell } from "../../src/review/ci/renderCiSummary.js";
import { renderClearedVerificationFailureStub } from "../../src/review/ci/verificationFailureBlock.js";
import { wrapDescriptionAgentBlock } from "../../src/agent/description/descriptionBodyMerge.js";
import { makeTestConfig } from "../helpers/config.js";
import {
  runInOperationIntentFrame,
  withOperationIntent,
  operationIntentMarker,
  type WithOperationIntentParams,
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
} from "../../src/agentWork/withOperationIntent.js";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";

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
    captureDurableWorkCompleted({
      item,
      workType: "review",
      outcome: "published",
      durationMs: 120,
      attemptCount: 1,
      publish: { publishAttempts: 0, publishStepCount: 5 },
      extras: { reviewLens: "review", source: "slash", findingsCount: 2 },
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
      const payload = {
        title: "Golden title",
        type: ["Enhancement"],
        description: "Golden description",
      } satisfies DescriptionPayload;
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
                withOperationIntent<T>({
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
            ? surface.publishDescription(makeTestConfig(), payload, marker)
            : runInOperationIntentFrame(parent, () =>
                surface.publishDescription(makeTestConfig(), payload, marker),
              );
        if (status === "pending" || status === "outcome_unknown") {
          await expect(replay()).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
          await expect(replay()).rejects.toMatchObject({
            code: "operation_intent.mutation_outcome_unknown",
          });
        } else {
          await expect(replay()).resolves.toMatchObject(result);
          await expect(replay()).resolves.toMatchObject(result);
        }
        expect(controls.events.filter((event) => event.kind === "publishDescription")).toHaveLength(
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
                withOperationIntent<T>({
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
            surface.publishDescription(
              makeTestConfig(),
              { title: "Golden title", type: ["Enhancement"], description: "Golden description" },
              marker,
            ),
          ),
        ).rejects.toMatchObject({ code: "operation_intent.description_identity_conflict" });
        expect(controls.events.filter((event) => event.kind === "publishDescription")).toHaveLength(
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
              withOperationIntent({
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
          await surface.publishDescription(
            makeTestConfig(),
            { title: "Golden title", type: ["Enhancement"], description: "Golden description" },
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
        ["publishDescription", "bf162594f55498fbf415bfab2fe1436e1dc15c53221dc7a4b34fa0eed967bb33"],
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
        await recordPublishStep(pool, {
          workItemId,
          resourceKey,
          reviewLens,
          step,
          leaseEpoch: null,
          githubId: 70,
          detail: { golden: true },
        });
      }
      await claimSummaryCommentCreation(pool, workItemId, resourceKey, "review", null);
      await recordReviewCheckRun(pool, {
        workItemId,
        resourceKey,
        reviewLens: "review",
        githubId: 70,
        leaseEpoch: null,
      });
      await recordAskPublishStep(pool, {
        workItemId,
        resourceKey,
        step: "ask_reply",
        githubId: 70,
        leaseEpoch: null,
      });
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
              withOperationIntent({
                client: pool,
                workItemId,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                recover: mutation.recover as WithOperationIntentParams<
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
        recordPublishStep(pool, {
          workItemId,
          leaseEpoch: null,
          resourceKey,
          reviewLens: "review",
          step: "inline_review",
          githubId: detail.reviewId,
          detail,
        });

      await write(firstBatch);
      await write(firstBatch);
      await write(secondBatch);
      await recordPublishStep(pool, {
        workItemId,
        leaseEpoch: null,
        resourceKey,
        reviewLens: "review-security",
        step: "inline_review",
        githubId: 40,
        detail: { fingerprints: ["fp-legacy"] },
      });

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
        const failure = await withOperationIntent(params).catch((error: unknown) => error);
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
        expect(await withOperationIntent(params)).toEqual(check);
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
        expect(await withOperationIntent(params)).toEqual(check);
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
      const boss = new PgBoss({ connectionString: cfg.databaseUrl });
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
        await recordPublishStep(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 70,
          leaseEpoch: null,
          detail: { findings: [] },
        });
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
              withOperationIntent({
                client: pool,
                workItemId,
                leaseEpoch: 1,
                operationKey: mutation.operationKey,
                mutationKind: mutation.mutationKind,
                detail: mutation.detail,
                mutate,
                recover: mutation.recover as WithOperationIntentParams<
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

        const attemptCap = cfg.queueRetryLimit + 1;
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
          expect(controls.events.filter((event) => event.kind === "editComment")).toHaveLength(1);
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
        await recordPublishStep(pool, {
          workItemId,
          resourceKey,
          reviewLens: "review",
          step: "summary_comment",
          githubId: 90,
          leaseEpoch: null,
          detail: {},
        });
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
          withOperationIntent({ ...params, isKnownNoAcceptanceError: () => true }),
        ).rejects.toMatchObject({
          code: "operation_intent.mutation_failed",
        });
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.status,
        ).toBe("failed");
        expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
        expect(mutate).toHaveBeenCalledTimes(2);
      } else if (scenario === "void ledger") {
        expect(await withOperationIntent(params)).toBeUndefined();
        expect(
          (await intentRepository.getOperationIntent(pool, workItemId, operationKey))?.detail
            .__result,
        ).toBeNull();
      } else {
        const error = await withOperationIntent(params).catch((failure: unknown) => failure);
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
          expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
          const readCount = recover.mock.calls.length;
          expect(await withOperationIntent(params)).toEqual({ commentId: 90 });
          expect(recover).toHaveBeenCalledTimes(readCount);
        } else if (scenario === "cached terminal" || scenario === "typed absence") {
          const readCount = recover.mock.calls.length;
          const lookupCount = lookup.mock.calls.length;
          for (let replay = 0; replay < 2; replay++) {
            const next = await withOperationIntent(params).catch((failure: unknown) => failure);
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
            code: "operation_intent.mutation_outcome_unknown",
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
});
