import { createPublishContext } from "../../src/agentWork/publishOnce.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction } from "../../src/db/postgres.js";
import {
  acquirePrActorLease,
  assertPrActorLeaseHeld,
  releasePrActorLease,
} from "../../src/agentWork/prActorLease.js";
import * as repository from "../../src/agentWork/publishRecordRepository.js";
import * as evlog from "../../src/evlog.js";
import { createFakePrSurface } from "../../src/github/prSurface.js";
import { isKnownNoAcceptanceMutationError } from "../../src/github/mutationErrorContract.js";
import { publishOnce } from "../../src/agentWork/publishOnce.js";
import { createReviewSummaryComment } from "../../src/review/publish/reviewSummaryComment.js";
import { tickProgressComment } from "../../src/review/orchestrator/stubTick.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../src/review/reviewSchema.js";
import {
  createAskWorkItem,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createTriageWorkItem,
  createVerificationWorkItem,
  recordReviewLifecycleObservation,
} from "../../src/agentWork/intake/workItemRepository.js";
import { acquireAutoWorkIntakeLock } from "../../src/agentWork/autoWorkEnqueue.js";
import { createReviewRescheduleWorkItem } from "../../src/agentWork/reviewReschedule.js";
import {
  getReviewQueuePosition,
  getWorkItem,
} from "../../src/agentWork/workItemStateRepository.js";
import {
  getProgressCommentOwner,
  getProgressCommentRevision,
} from "../../src/agentWork/publishRecordRepository.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "work-item-repo-it";
const EVENT = "work-item-repo-it";

async function insertWebhookEvent(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
     VALUES ($1, $2, $3, 'sha', 'accepted')`,
    [id, `dedupe-${id}`, EVENT],
  );
}

function makeRef(repo: string, prNumber: number) {
  return {
    owner: OWNER,
    repo,
    prNumber,
    installationId: 4242,
    headSha: "sha-head",
  };
}

describe.skipIf(!hasDatabase)("work item repository inserts (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("DELETE FROM pr_review_lifecycle WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  async function acquireReviewLease(workItemId: string, resourceKey: string): Promise<number> {
    const acquisition = await acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId,
      holderId: "work-item-repo-it-holder",
      ttlSeconds: 900,
    });
    if (!acquisition.acquired) throw new Error(`expected lease acquisition for ${workItemId}`);
    return acquisition.leaseEpoch;
  }

  it.each([
    { scenario: "older first", older: 2 as const, newer: 3 as const, seeded: true },
    { scenario: "newer first", older: 3 as const, newer: 2 as const, seeded: true },
    { scenario: "equal revisions", older: 2 as const, newer: 2 as const, seeded: true },
    { scenario: "absent comment", older: 2 as const, newer: 3 as const, seeded: false },
  ])(
    "serializes concurrent progress ticks ($scenario)",
    async ({ older: first, newer: second, seeded }) => {
      const repo = `repo-${randomUUID().slice(0, 8)}`;
      const ref = makeRef(repo, 19);
      const resourceKey = prResourceKey(OWNER, repo, 19);
      const eventId = randomUUID();
      const work = await inTransaction(pool, async (client) => {
        await insertWebhookEvent(client, eventId);
        return createReviewWorkItem(client, { webhookEventId: eventId, source: "slash", ref });
      });
      const fake = createFakePrSurface({ owner: OWNER, repo, prNumber: 19 });
      const warn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
      const tick = {
        pool,
        workItemId: work.id,
        resourceKey,
        owner: OWNER,
        repo,
        prNumber: 19,
        mode: "review" as const,
        headSha: ref.headSha,
        source: "slash" as const,
        prSurface: fake.surface,
        progressRevision: 1 as const,
        tickState: {
          kind: "specialists" as const,
          recon: "done" as const,
          specialists: {
            correctness: { phase: "done" as const, findingsAccepted: 1 },
            security: { phase: "running" as const },
            quality: { phase: "running" as const },
            tests: { phase: "running" as const },
          },
        },
      };
      if (seeded) await tickProgressComment(tick);
      const commentId = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.id;
      let signalPaused = () => {};
      const paused = new Promise<void>((resolve) => {
        signalPaused = resolve;
      });
      let continueWrite = () => {};
      const resume = new Promise<void>((resolve) => {
        continueWrite = resolve;
      });
      let signalContention = () => {};
      let rejectContention = (_error: unknown) => {};
      const contended = new Promise<void>((resolve, reject) => {
        signalContention = resolve;
        rejectContention = reject;
      });
      const upsert = fake.surface.upsertProgressComment.bind(fake.surface);
      vi.spyOn(fake.surface, "upsertProgressComment").mockImplementationOnce(async (...args) => {
        signalPaused();
        await resume;
        return upsert(...args);
      });
      const older = tickProgressComment({
        ...tick,
        progressRevision: first,
        tickState: {
          ...tick.tickState,
          specialists: {
            ...tick.tickState.specialists,
            correctness: { phase: "done", findingsAccepted: first },
          },
        },
      });
      let newer: Promise<void> | undefined;
      // Observe the existing lock only to release the barrier on either implementation.
      // The oracle is the final public body and durable record, not lock metadata.
      const observeLock = (client: PoolClient) => {
        void client
          .query<{ held: boolean }>(
            `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
                AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                AND objid = (hashtextextended($1, 0) & 4294967295)::oid
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           ) AS held`,
            [JSON.stringify([resourceKey, "review"])],
          )
          .then(({ rows }) => {
            if (rows[0]?.held) signalContention();
          }, rejectContention);
      };
      try {
        await paused;
        pool.on("acquire", observeLock);
        newer = tickProgressComment({
          ...tick,
          progressRevision: second,
          tickState: {
            ...tick.tickState,
            specialists: {
              ...tick.tickState.specialists,
              correctness: { phase: "done", findingsAccepted: second },
            },
          },
        });
        await Promise.race([newer, contended]);
        pool.off("acquire", observeLock);
        continueWrite();
        await Promise.all([older, newer]);

        const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
        const expectedRevision = Math.max(first, second);
        if (seeded) expect(comment?.id).toBe(commentId);
        expect(comment?.id).toBeGreaterThan(0);
        expect(comment?.body).toContain(`${expectedRevision} findings`);
        expect(comment?.body).toContain(`workItemId=${work.id} value=${expectedRevision}`);
        expect(
          fake.controls.events.filter((event) => event.kind === "upsertProgressComment"),
        ).toHaveLength((seeded ? 1 : 0) + (first < second ? 2 : 1));
        expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
          workItemId: work.id,
          revision: expectedRevision,
        });
        const record = await pool.query<{ github_id: string; work_item_id: string }>(
          `SELECT github_id, work_item_id FROM publish_records
          WHERE resource_key = $1 AND step = 'progress_comment'`,
          [resourceKey],
        );
        expect(record.rows).toEqual([{ github_id: String(comment?.id), work_item_id: work.id }]);
        expect(warn).not.toHaveBeenCalledWith("review_progress_tick_failed", expect.anything());
      } finally {
        pool.off("acquire", observeLock);
        continueWrite();
        await Promise.allSettled([older, ...(newer ? [newer] : [])]);
      }
    },
  );

  it.each([
    { distinct: false, occupied: false },
    { distinct: true, occupied: false },
    { distinct: true, occupied: true },
  ])(
    "publishes under shared-pool pressure with distinct keys=$distinct and unrelated checkout=$occupied",
    async ({ distinct, occupied }) => {
      const contexts = await Promise.all(
        Array.from({ length: distinct ? 4 : 1 }, async () => {
          const repo = `repo-${randomUUID().slice(0, 8)}`;
          const ref = makeRef(repo, 20);
          const eventId = randomUUID();
          const work = await inTransaction(pool, async (client) => {
            await insertWebhookEvent(client, eventId);
            return createReviewWorkItem(client, { webhookEventId: eventId, source: "slash", ref });
          });
          return {
            work,
            resourceKey: prResourceKey(OWNER, repo, 20),
            fake: createFakePrSurface({ owner: OWNER, repo, prNumber: 20 }),
          };
        }),
      );
      let signalEntered = () => {};
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let continueWrite = () => {};
      const resume = new Promise<void>((resolve) => {
        continueWrite = resolve;
      });
      let arrivals = 0;
      for (const { fake } of contexts) {
        const upsert = fake.surface.upsertProgressComment.bind(fake.surface);
        vi.spyOn(fake.surface, "upsertProgressComment").mockImplementation(async (...args) => {
          arrivals++;
          if (arrivals === (distinct ? 2 : 1)) signalEntered();
          await resume;
          await pool.query("SELECT 1");
          return upsert(...args);
        });
      }
      const checkoutTimeout = pool.options.connectionTimeoutMillis;
      if (occupied) pool.options.connectionTimeoutMillis = 1_000;
      const unrelated = occupied ? await pool.connect() : undefined;
      const pending = ([2, 3, 4, 5] as const).map((revision, index) => {
        const context = contexts[distinct ? index : 0];
        if (!context) throw new Error("missing pressure context");
        return createReviewSummaryComment({
          prSurface: context.fake.surface,
          reviewLens: "review",
          coordination: { pool, resourceKey: context.resourceKey, workItemId: context.work.id },
        }).tick({
          body: `${REVIEW_SUMMARY_SENTINEL}\npressure-${index}`,
          progressRevision: distinct ? 2 : revision,
        });
      });
      try {
        await entered;
        continueWrite();
        await Promise.all(pending);
        for (const { work, resourceKey, fake } of contexts) {
          const revision = distinct ? 2 : 5;
          const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
          expect(comment?.body).toContain(`workItemId=${work.id} value=${revision}`);
          expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
            workItemId: work.id,
            revision,
          });
        }
      } finally {
        continueWrite();
        unrelated?.release();
        await Promise.allSettled(pending);
        pool.options.connectionTimeoutMillis = checkoutTimeout;
      }
    },
  );

  it("retries an exhausted summary intent only after proven nonacceptance", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 21);
    const eventId = randomUUID();
    const work = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, eventId);
      return createReviewWorkItem(client, {
        webhookEventId: eventId,
        source: "slash",
        ref: makeRef(repo, 21),
      });
    });
    const fake = createFakePrSurface({ owner: OWNER, repo, prNumber: 21 });
    let signalPaused = () => {};
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let continueWrite = () => {};
    const resume = new Promise<void>((resolve) => {
      continueWrite = resolve;
    });
    const upsert = fake.surface.upsertProgressComment.bind(fake.surface);
    vi.spyOn(fake.surface, "upsertProgressComment").mockImplementationOnce(async (...args) => {
      signalPaused();
      await resume;
      return upsert(...args);
    });
    const summary = createReviewSummaryComment({
      prSurface: fake.surface,
      reviewLens: "review",
      coordination: { pool, resourceKey, workItemId: work.id },
    });
    const holder = summary.tick({
      body: `${REVIEW_SUMMARY_SENTINEL}\nholder`,
      progressRevision: 2,
    });
    const operationKey = `review:summary:review:${resourceKey}`;
    const intent = {
      client: pool,
      workItemId: work.id,
      operationKey,
      mutationKind: "github.summary_comment",
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () => summary.conclude({ body: `${REVIEW_SUMMARY_SENTINEL}\nwinner` }),
    };
    try {
      await paused;
      await expect(publishOnce(intent)).rejects.toMatchObject({
        code: "review.progress_lock_timeout",
        mutationAccepted: false,
      });
      expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)).toBeNull();
      const failed = await pool.query<{ status: string }>(
        "SELECT status FROM operation_intents WHERE work_item_id = $1 AND operation_key = $2",
        [work.id, operationKey],
      );
      expect(failed.rows).toEqual([{ status: "failed" }]);
      continueWrite();
      await holder;
      await publishOnce(intent);
      const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
      expect(comment?.body).toContain("winner");
      expect(comment?.body).toContain(`workItemId=${work.id} value=7`);
      expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
        workItemId: work.id,
        revision: 7,
      });
    } finally {
      continueWrite();
      await Promise.allSettled([holder]);
    }
  });

  it("returns created id for slash review and records progress_comment", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const webhookEventId = randomUUID();
    const ref = makeRef(repo, 10);
    const resourceKey = prResourceKey(OWNER, repo, 10);

    const result = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, webhookEventId);
      return createReviewWorkItem(client, {
        webhookEventId,
        source: "slash",
        ref,
      });
    });

    expect(result).toEqual({ created: true, id: expect.any(String) });
    const publish = await pool.query<{ step: string; status: string }>(
      `SELECT step, status FROM publish_records
        WHERE resource_key = $1 AND review_lens = 'review'`,
      [resourceKey],
    );
    expect(publish.rows).toEqual([{ step: "progress_comment", status: "pending" }]);
  });

  it("keeps one active slash review winner", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 11);
    const resourceKey = prResourceKey(OWNER, repo, 11);

    const firstEvent = randomUUID();
    const secondEvent = randomUUID();
    const first = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, firstEvent);
      return createReviewWorkItem(client, {
        webhookEventId: firstEvent,
        source: "slash",
        ref,
      });
    });
    const second = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, secondEvent);
      return createReviewWorkItem(client, {
        webhookEventId: secondEvent,
        source: "slash",
        ref,
      });
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, id: first.id });

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND review_lens = $2
          AND source = 'slash' AND status = 'queued'`,
      [resourceKey, "review"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
  });

  it("returns winner for description and triage without follow-up races", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 12);

    const descEvent = randomUUID();
    const descDup = randomUUID();
    const triageEvent = randomUUID();
    const triageDup = randomUUID();

    const desc = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, descEvent);
      return createDescriptionWorkItem(client, {
        webhookEventId: descEvent,
        source: "slash",
        ref,
      });
    });
    const descConflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, descDup);
      return createDescriptionWorkItem(client, {
        webhookEventId: descDup,
        source: "slash",
        ref,
      });
    });
    expect(desc.created).toBe(true);
    expect(descConflict).toEqual({ created: false, id: desc.id });

    const triage = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, triageEvent);
      return createTriageWorkItem(client, {
        webhookEventId: triageEvent,
        ref,
        commentId: 1,
        scope: "all",
        replyTarget: { kind: "prConversation", prNumber: 12 },
      });
    });
    const triageConflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, triageDup);
      return createTriageWorkItem(client, {
        webhookEventId: triageDup,
        ref,
        commentId: 2,
        scope: "thread",
        replyTarget: { kind: "inlineReviewThread", prNumber: 12, inReplyToCommentId: 2 },
      });
    });
    expect(triage.created).toBe(true);
    expect(triageConflict).toEqual({ created: false, id: triage.id });
  });

  it("preserves ask webhook idempotency via conflict-aware insert", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 13);
    const webhookEventId = randomUUID();

    const first = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, webhookEventId);
      return createAskWorkItem(client, {
        webhookEventId,
        ref,
        question: "what changed?",
        replyTarget: { kind: "prConversation", prNumber: 13 },
        commentId: 3,
        commenterId: 9,
      });
    });
    const second = await inTransaction(pool, async (client) =>
      createAskWorkItem(client, {
        webhookEventId,
        ref,
        question: "what changed again?",
        replyTarget: { kind: "prConversation", prNumber: 13 },
        commentId: 4,
        commenterId: 9,
      }),
    );

    expect(first).toEqual({ created: true, id: expect.any(String) });
    expect(second).toEqual({ created: false, id: first.id });

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE webhook_event_id = $1 AND type = 'ask'`,
      [webhookEventId],
    );
    expect(rows).toHaveLength(1);
  });

  it("allows auto verification beside slash work and returns plain ids", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 14);
    const slashEvent = randomUUID();
    const autoEvent = randomUUID();

    const slash = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, slashEvent);
      return createDescriptionWorkItem(client, {
        webhookEventId: slashEvent,
        source: "slash",
        ref,
      });
    });
    const verificationId = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, autoEvent);
      return createVerificationWorkItem(client, {
        webhookEventId: autoEvent,
        ref,
      });
    });

    expect(slash.created).toBe(true);
    expect(typeof verificationId).toBe("string");
    expect(verificationId).not.toBe(slash.id);
  });

  it("allows staleHeadRescheduled replacement beside a running slash parent", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 15);
    const resourceKey = prResourceKey(OWNER, repo, 15);
    const parentEvent = randomUUID();
    const replacementEvent = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted'), ($4, $5, $3, 'sha', 'accepted')`,
      [parentEvent, `p-${parentEvent}`, EVENT, replacementEvent, `r-${replacementEvent}`],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 15, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        parentId,
        parentEvent,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'queued', $3, $4, 15, 4242, 'sha-new', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        replacementId,
        replacementEvent,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    const thirdEvent = randomUUID();
    const conflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, thirdEvent);
      return createReviewWorkItem(client, {
        webhookEventId: thirdEvent,
        source: "slash",
        ref,
      });
    });

    // Parent is still the active non-replacement slash winner.
    expect(conflict).toEqual({ created: false, id: parentId });

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'
        ORDER BY status, id`,
      [resourceKey],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: parentId, status: "running" },
        { id: replacementId, status: "queued" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it.each(["missing", "open", "reopened", "closed", "merged", "closed-after-wait"] as const)(
    "transfers progress ownership only for an admitted stale-head replacement (#662): %s",
    async (state) => {
      const repo = `repo-${randomUUID().slice(0, 8)}`;
      const resourceKey = prResourceKey(OWNER, repo, 17);
      const webhookEventId = randomUUID();
      const parentId = randomUUID();

      await pool.query(
        `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
        [webhookEventId, `p-${webhookEventId}`, EVENT],
      );
      await pool.query(
        `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 17, 4242, 'sha-old', 'review', $5, 0,
         '{"mode":"review","source":"slash"}'::jsonb
       )`,
        [parentId, webhookEventId, OWNER, repo, resourceKey],
      );
      await pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, detail)
       VALUES ($1, $2, $3, 'review', 'progress_comment', 'completed',
               '{"progressGeneration":4,"progressRevision":6}'::jsonb)`,
        [randomUUID(), parentId, resourceKey],
      );

      const parent = await getWorkItem(pool, parentId);
      expect(parent?.type).toBe("review");
      if (parent?.type !== "review") throw new Error("expected review parent");
      const leaseEpoch = await acquireReviewLease(parentId, resourceKey);

      if (state !== "missing") {
        await inTransaction(pool, async (client) => {
          await acquireAutoWorkIntakeLock(client, { kind: "review", resourceKey });
          if (state === "reopened")
            await recordReviewLifecycleObservation(
              client,
              resourceKey,
              { state: "closed", observedAt: "2026-10-01T00:00:01Z" },
              webhookEventId,
            );
          await recordReviewLifecycleObservation(
            client,
            resourceKey,
            {
              state: state === "closed" || state === "merged" ? state : "open",
              observedAt: "2026-10-01T00:00:02Z",
            },
            webhookEventId,
          );
        });
      }
      if (state === "closed" || state === "merged" || state === "closed-after-wait") {
        const originalPayload = parent.payload;
        let replacement: ReturnType<typeof createReviewRescheduleWorkItem> | undefined;
        if (state === "closed-after-wait") {
          const blocker = await pool.connect();
          let open = false;
          try {
            await blocker.query("BEGIN");
            open = true;
            await acquireAutoWorkIntakeLock(blocker, { kind: "review", resourceKey });
            const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            replacement = createReviewRescheduleWorkItem(pool, parent, leaseEpoch);
            let finished = false;
            void replacement.then(
              () => {
                finished = true;
              },
              () => {
                finished = true;
              },
            );
            await expect
              .poll(
                async () => {
                  const blocked = (
                    await pool.query<{ blocked: boolean }>(
                      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS blocked",
                      [pid],
                    )
                  ).rows[0].blocked;
                  return blocked || finished;
                },
                { timeout: 5000 },
              )
              .toBe(true);
            await recordReviewLifecycleObservation(
              blocker,
              resourceKey,
              { state: "closed", observedAt: "2026-10-01T00:00:03Z" },
              webhookEventId,
            );
            await blocker.query("COMMIT");
            open = false;
          } finally {
            if (open) await blocker.query("ROLLBACK");
            blocker.release();
            if (open) await replacement?.catch(() => undefined);
          }
        } else replacement = createReviewRescheduleWorkItem(pool, parent, leaseEpoch);
        await expect(replacement).rejects.toMatchObject({
          code: "agent_work.stale_head_parent_not_reschedulable",
        });
        expect((await getWorkItem(pool, parentId))?.payload).toEqual(originalPayload);
        expect(await getProgressCommentOwner(pool, resourceKey, "review")).toEqual({
          workItemId: parentId,
          generation: 4,
        });
        expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
          workItemId: parentId,
          revision: 6,
        });
        expect(
          (
            await pool.query("SELECT id FROM agent_work_items WHERE resource_key = $1", [
              resourceKey,
            ])
          ).rows,
        ).toEqual([{ id: parentId }]);
        return;
      }

      const replacement = await createReviewRescheduleWorkItem(pool, parent, leaseEpoch);
      const owner = await getProgressCommentOwner(pool, resourceKey, "review");

      const persistedParent = await getWorkItem(pool, parentId);
      expect(persistedParent?.type).toBe("review");
      if (persistedParent?.type !== "review") throw new Error("expected review parent");
      expect(persistedParent.payload.staleHeadReplacement).toEqual({
        replacementWorkItemId: replacement.replacementWorkItemId,
        state: "pending-enqueue",
      });
      expect(persistedParent.payload).not.toHaveProperty("staleHeadReplacementWorkItemId");

      const reused = await createReviewRescheduleWorkItem(pool, persistedParent, leaseEpoch);
      expect(reused.replacementWorkItemId).toBe(replacement.replacementWorkItemId);
      const { rows: replacements } = await pool.query<{ id: string }>(
        `SELECT id FROM agent_work_items WHERE resource_key = $1 AND id <> $2`,
        [resourceKey, parentId],
      );
      expect(replacements).toEqual([{ id: replacement.replacementWorkItemId }]);

      expect(owner).toEqual({ workItemId: replacement.replacementWorkItemId, generation: 5 });
      expect(await getProgressCommentRevision(pool, resourceKey, "review")).toBeNull();

      await createPublishContext(pool, {
        workItemId: replacement.replacementWorkItemId,
        leaseEpoch: null,
        resourceKey,
        reviewLens: "review",
        step: "progress_comment",
        detail: { progressRevision: 0 },
      }).record();
      const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
      await assertPrActorLeaseHeld(pool, parentId, leaseEpoch);
      for (const epoch of [leaseEpoch, null]) {
        await expect(
          createPublishContext(pool, {
            workItemId: parentId,
            leaseEpoch: epoch,
            resourceKey,
            reviewLens: "review",
            step: "progress_comment",
            detail: { progressRevision: 6 },
          }).record(),
        ).rejects.toMatchObject({ code: "agent_work.progress_comment_ownership_conflict" });
      }
      expect(logWarn).toHaveBeenCalledWith(
        "review_progress_publish_record_conflict",
        expect.objectContaining({
          errorCode: "agent_work.progress_comment_ownership_conflict",
          errorContext: expect.objectContaining({ workItemId: parentId, resourceKey }),
        }),
      );

      expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
        workItemId: replacement.replacementWorkItemId,
        revision: 0,
      });
      await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch });
      await expect(
        createPublishContext(pool, {
          workItemId: parentId,
          leaseEpoch,
          resourceKey,
          reviewLens: "review",
          step: "progress_comment",
          detail: { progressRevision: 6 },
        }).record(),
      ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });
    },
  );

  it.each(
    (["slash", "auto", "parent"] as const).flatMap((transfer) =>
      (["preflight", "claim", "record"] as const).map((checkpoint) => ({
        transfer,
        checkpoint,
      })),
    ),
  )(
    "surfaces a stale specialist tick after $transfer transfer at $checkpoint",
    async ({ transfer, checkpoint }) => {
      const repo = `repo-${randomUUID().slice(0, 8)}`;
      const ref = makeRef(repo, 18);
      const resourceKey = prResourceKey(OWNER, repo, 18);
      const eventId = randomUUID();
      const first = await inTransaction(pool, async (client) => {
        await insertWebhookEvent(client, eventId);
        return transfer === "slash"
          ? createReviewWorkItem(client, { webhookEventId: eventId, source: "auto", ref })
          : createReviewWorkItem(client, { webhookEventId: eventId, source: "slash", ref });
      });
      const parentId = typeof first === "string" ? first : first.id;
      await pool.query("UPDATE agent_work_items SET status = 'running' WHERE id = $1", [parentId]);
      const leaseEpoch = await acquireReviewLease(parentId, resourceKey);
      const fake = createFakePrSurface({ owner: OWNER, repo, prNumber: 18 });
      const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
      const tick = {
        pool,
        workItemId: parentId,
        resourceKey,
        owner: OWNER,
        repo,
        prNumber: 18,
        mode: "review" as const,
        headSha: ref.headSha,
        source: transfer === "slash" ? ("auto" as const) : ("slash" as const),
        prSurface: fake.surface,
        progressRevision: 2 as const,
        tickState: {
          kind: "specialists" as const,
          recon: "done" as const,
          specialists: {
            correctness: { phase: "done" as const, findingsAccepted: 0 },
            security: { phase: "running" as const },
            quality: { phase: "running" as const },
            tests: { phase: "running" as const },
          },
        },
      };
      await tickProgressComment(tick);
      const commentId = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.id;
      expect(commentId).toBeDefined();

      let reached = () => {};
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let resume = () => {};
      const continued = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (checkpoint === "claim") {
        const readStub = repository.getProgressStubPostedAtMs;
        vi.spyOn(repository, "getProgressStubPostedAtMs").mockImplementationOnce(
          async (...args) => {
            const result = await readStub(...args);
            reached();
            await continued;
            return result;
          },
        );
      } else if (checkpoint === "record") {
        const upsert = fake.surface.upsertProgressComment;
        vi.spyOn(fake.surface, "upsertProgressComment").mockImplementationOnce(async (...args) => {
          const result = await upsert(...args);
          reached();
          await continued;
          return result;
        });
      }
      const staleTick = {
        ...tick,
        progressRevision: 3 as const,
        tickState: {
          ...tick.tickState,
          specialists: {
            ...tick.tickState.specialists,
            correctness: { phase: "done" as const, findingsAccepted: 9 },
          },
        },
      };
      const pending = checkpoint === "preflight" ? null : tickProgressComment(staleTick);
      let winner: Promise<void> | undefined;
      try {
        if (pending != null) await paused;
        let replacementId: string;
        if (transfer === "parent") {
          const parent = await getWorkItem(pool, parentId);
          if (parent?.type !== "review") throw new Error("expected running review parent");
          replacementId = (await createReviewRescheduleWorkItem(pool, parent, leaseEpoch))
            .replacementWorkItemId;
        } else {
          const replacementEvent = randomUUID();
          const replacement = await inTransaction(pool, async (client) => {
            await insertWebhookEvent(client, replacementEvent);
            return transfer === "slash"
              ? createReviewWorkItem(client, {
                  webhookEventId: replacementEvent,
                  source: "slash",
                  ref,
                })
              : createReviewWorkItem(client, {
                  webhookEventId: replacementEvent,
                  source: "auto",
                  ref,
                });
          });
          replacementId = typeof replacement === "string" ? replacement : replacement.id;
        }
        await assertPrActorLeaseHeld(pool, parentId, leaseEpoch);
        const winnerTick = {
          ...tick,
          workItemId: replacementId,
          tickState: {
            ...tick.tickState,
            specialists: {
              ...tick.tickState.specialists,
              correctness: { phase: "done" as const, findingsAccepted: 1 },
            },
          },
        };
        winner = tickProgressComment(winnerTick);
        const writesBefore = fake.controls.events.filter(
          (event) =>
            event.kind === "upsertProgressComment" &&
            event.body.includes(`workItemId=${parentId} value=3`),
        ).length;
        if (pending == null) {
          await tickProgressComment(staleTick);
        } else {
          resume();
          await pending;
        }
        expect(
          fake.controls.events.filter(
            (event) =>
              event.kind === "upsertProgressComment" &&
              event.body.includes(`workItemId=${parentId} value=3`),
          ),
        ).toHaveLength(writesBefore);
        await winner;
        const winnerBody = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
        expect(winnerBody).toContain(`workItemId=${replacementId} value=2`);
        expect(winnerBody).not.toContain("9 findings");
        expect(logWarn).toHaveBeenCalledWith(
          checkpoint === "preflight"
            ? "review_progress_skipped_foreign_owner"
            : "review_progress_publish_record_conflict",
          expect.objectContaining(
            checkpoint === "preflight"
              ? { workItemId: parentId, ownerWorkItemId: replacementId, progressRevision: 3 }
              : {
                  errorCode: "agent_work.progress_comment_ownership_conflict",
                  errorContext: expect.objectContaining({ workItemId: parentId, resourceKey }),
                },
          ),
        );
        expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
          workItemId: replacementId,
          revision: 2,
        });
        await tickProgressComment({ ...winnerTick, progressRevision: 3 });
        const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
        expect(comment?.id).toBe(commentId);
        expect(comment?.body).toContain(`workItemId=${replacementId} value=3`);
        expect(comment?.body).not.toContain("9 findings");
      } finally {
        resume();
        await Promise.allSettled([...(pending ? [pending] : []), ...(winner ? [winner] : [])]);
      }
    },
  );

  it("concurrent same-scope slash description inserts yield one winner id", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 16);
    const events = [randomUUID(), randomUUID(), randomUUID()];

    await Promise.all(
      events.map((webhookEventId) =>
        pool.query(
          `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
           VALUES ($1, $2, $3, 'sha', 'accepted')`,
          [webhookEventId, `c-${webhookEventId}`, EVENT],
        ),
      ),
    );

    const results = await Promise.all(
      events.map((webhookEventId) =>
        inTransaction(pool, (client) =>
          createDescriptionWorkItem(client, {
            webhookEventId,
            source: "slash",
            ref,
          }),
        ),
      ),
    );

    const created = results.filter((r) => r.created);
    const losers = results.filter((r) => !r.created);
    expect(created).toHaveLength(1);
    expect(losers).toHaveLength(2);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(losers.every((r) => r.id === created[0]?.id)).toBe(true);

    const resourceKey = prResourceKey(OWNER, repo, 16);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND source = 'slash'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created[0]?.id);
  });

  it("ranks queued reviews per resource_key with self-inclusive FIFO position SQL", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const events = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of events) {
      await pool.query(
        `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
         VALUES ($1, $2, $3, 'sha', 'accepted')`,
        [id, `dedupe-${id}`, EVENT],
      );
    }

    const firstSamePrId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[0],
        source: "auto",
        ref: makeRef(repo, 101),
      }),
    );
    const secondSamePrId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[1],
        source: "auto",
        ref: makeRef(repo, 101),
      }),
    );
    const otherPrId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[2],
        source: "auto",
        ref: makeRef(repo, 102),
      }),
    );
    const runningId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[3],
        source: "auto",
        ref: makeRef(repo, 101),
      }),
    );
    const askInsert = await inTransaction(pool, (client) =>
      createAskWorkItem(client, {
        webhookEventId: events[4],
        ref: makeRef(repo, 101),
        question: "queue noise?",
        replyTarget: { kind: "prConversation", prNumber: 101 },
        commentId: 50,
        commenterId: 9,
      }),
    );

    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      firstSamePrId,
      "2026-01-01T00:00:01Z",
    ]);
    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      secondSamePrId,
      "2026-01-01T00:00:02Z",
    ]);
    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      otherPrId,
      "2026-01-01T00:00:03Z",
    ]);
    await pool.query(
      `UPDATE agent_work_items SET status = 'running', created_at = $2 WHERE id = $1`,
      [runningId, "2026-01-01T00:00:00Z"],
    );
    expect(askInsert.id).toBeTruthy();

    await expect(getReviewQueuePosition(pool, firstSamePrId)).resolves.toEqual({
      position: 1,
      total: 2,
    });
    await expect(getReviewQueuePosition(pool, secondSamePrId)).resolves.toEqual({
      position: 2,
      total: 2,
    });
    await expect(getReviewQueuePosition(pool, otherPrId)).resolves.toEqual({
      position: 1,
      total: 1,
    });
    await expect(getReviewQueuePosition(pool, runningId)).resolves.toBeNull();
    await expect(getReviewQueuePosition(pool, askInsert.id)).resolves.toBeNull();
    await expect(getReviewQueuePosition(pool, randomUUID())).resolves.toBeNull();
  });
});
