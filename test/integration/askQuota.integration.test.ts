import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import type { WebhookHeaders } from "../../src/agentWork/types.ts";
import type { SlashCommandInput } from "../../src/agentWork/types.ts";
import { AppError } from "../../src/errors/appError.ts";
import { runDelivery, type IntakeFeatures } from "../../src/state/intake.ts";
import {
  actorScopeKey,
  createAskExecutionId,
  defaultAskQuotaConfig,
  installationScopeKey,
  recordAskProviderUsage,
  repositoryScopeKey,
  reserveAskQuota,
  type AskQuotaConfig,
} from "../../src/state/askQuotas.ts";
import {
  claimDispatchableWorkRun,
  insertWorkRun,
  markAttemptRunning,
  markWorkRunCompleted,
  markWorkRunFailed,
  scheduleWorkRunRetry,
} from "../../src/state/workRuns.ts";
import { immediate, readRows } from "../../src/state/db.ts";
import { openSqliteAppState } from "./db.ts";

const OWNER = "ask-quota-it";
const INSTALLATION_ID = 9481;
const REPO = "app";
const PR_NUMBER = 481;

const BASE_QUOTA: AskQuotaConfig = {
  ...defaultAskQuotaConfig(),
  actorMaxOutstanding: 2,
  repositoryMaxOutstanding: 20,
  installationMaxOutstanding: 20,
  actorBurst: 100,
  repositoryBurst: 100,
  installationBurst: 100,
  actorRefillSeconds: 100_000,
  repositoryRefillSeconds: 100_000,
  installationRefillSeconds: 100_000,
};

const FEATURES: IntakeFeatures = {
  review: "manual",
  reviewCadence: "once",
  describe: "manual",
  verification: "manual",
  ask: "manual",
  triage: "manual",
};

const state = openSqliteAppState();
const db = state.db;

afterAll(() => {
  state.close();
});

afterEach(() => {
  db.prepare(`DELETE FROM ask_quota_execution_receipts`).run();
  db.prepare(`DELETE FROM ask_quota_reservations`).run();
  db.prepare(`DELETE FROM ask_quota_buckets`).run();
  db.prepare(`DELETE FROM work_run_attempts`).run();
  db.prepare(`DELETE FROM work_runs`).run();
  db.prepare(`DELETE FROM webhook_rejections`).run();
  db.prepare(`DELETE FROM webhook_body_replays`).run();
  db.prepare(`DELETE FROM webhook_deliveries`).run();
});

const bucketSchema = v.object({
  scope: v.string(),
  scope_key: v.string(),
  token_balance: v.number(),
  outstanding_count: v.number(),
  provider_tokens_used: v.number(),
  provider_tokens_reserved: v.number(),
  provider_window_started_at: v.number(),
});

const reservationSchema = v.object({
  work_item_id: v.string(),
  reserved_provider_tokens: v.number(),
  provider_tokens_used: v.number(),
  released_at: v.nullable(v.number()),
});

function buckets(...scopeKeys: string[]) {
  const marks = scopeKeys.map(() => "?").join(",");
  return readRows(
    db
      .prepare(
        `SELECT * FROM ask_quota_buckets WHERE scope_key IN (${marks}) ORDER BY scope, scope_key`,
      )
      .all(...scopeKeys),
    bucketSchema,
  );
}

function reservation(workItemId: string) {
  return readRows(
    db.prepare(`SELECT * FROM ask_quota_reservations WHERE work_item_id = ?`).all(workItemId),
    reservationSchema,
  )[0];
}

function admit(
  workItemId: string,
  commenterId: number,
  config: AskQuotaConfig = BASE_QUOTA,
  repo = REPO,
  now = Date.now(),
) {
  return reserveAskQuota(
    db,
    {
      workItemId,
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      commenterId,
      triggerCommentId: Math.abs(
        Array.from(workItemId).reduce((acc, c) => acc + c.charCodeAt(0), 0),
      ),
    },
    config,
    now,
  );
}

function insertAskRun(workItemId: string) {
  const now = Date.now();
  insertWorkRun(db, {
    workId: workItemId,
    prKey: `${OWNER}/${REPO}#${PR_NUMBER}`,
    kind: "ask",
    payloadJson: JSON.stringify({ commentId: 1 }),
    now,
  });
}

function runToRunning(workItemId: string) {
  insertAskRun(workItemId);
  immediate(db, () => {
    const claimed = claimDispatchableWorkRun(db, Date.now());
    if (claimed?.run.work_id !== workItemId) throw new Error("claim missed the inserted ask run");
    markAttemptRunning(db, {
      workId: workItemId,
      attemptNo: claimed.attempt.attempt_no,
      conversationId: `conv-${workItemId}`,
      taskId: null,
      now: Date.now(),
    });
  });
}

function runToCompleted(workItemId: string) {
  runToRunning(workItemId);
  markWorkRunCompleted(db, { workId: workItemId, attemptNo: 1, now: Date.now() });
}

function slashAsk(prNumber: number, commentId: number, delivery: string, question = "/ask hi") {
  const headers: WebhookHeaders = {
    delivery,
    event: "issue_comment",
    rawBody: Buffer.from(JSON.stringify({ n: delivery })),
  };
  const input: SlashCommandInput = {
    headers,
    installationId: 1,
    owner: "o",
    repo: "r",
    prNumber,
    commentId,
    commenterId: 42,
    commenterLogin: "tester",
    body: question,
    command: "ask",
    replyTarget: { kind: "prConversation", prNumber },
  };
  return runDelivery(db, { features: FEATURES }, { kind: "slash", input });
}

function askRuns(prKey: string) {
  return readRows(
    db
      .prepare(`SELECT work_id, payload_json FROM work_runs WHERE pr_key = ? AND kind = 'ask'`)
      .all(prKey),
    v.object({ work_id: v.string(), payload_json: v.string() }),
  );
}

function triggerReservations() {
  return readRows(
    db.prepare(`SELECT work_item_id, trigger_comment_id FROM ask_quota_reservations`).all(),
    v.object({
      work_item_id: v.string(),
      trigger_comment_id: v.nullable(v.number()),
    }),
  );
}

describe("ask admission quotas (sqlite integration)", () => {
  it("compensates a webhook insertion conflict without an orphan quota reservation", () => {
    const first = slashAsk(PR_NUMBER, 999, "ask-retained-1");
    const second = slashAsk(PR_NUMBER, 999, "ask-retained-2");
    expect(first.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    expect(second.events.some((e) => e.name === "agent_work_enqueued")).toBe(false);
    const runs = askRuns(`o/r#${PR_NUMBER}`);
    expect(runs).toHaveLength(1);
    const workItemId = runs[0]?.work_id;
    if (workItemId === undefined) throw new Error("no admitted ask run");
    expect(triggerReservations()).toEqual([{ work_item_id: workItemId, trigger_comment_id: 999 }]);
    const kept = reservation(workItemId);
    expect(kept?.released_at).toBeNull();
    const installation = buckets(installationScopeKey(1))[0];
    expect(installation?.outstanding_count).toBe(1);
    const actor = buckets(actorScopeKey(1, 42))[0];
    expect(actor?.outstanding_count).toBe(1);
  });

  it("serializes concurrent admissions and releases outstanding capacity on completion", () => {
    const workItemIds = Array.from({ length: 5 }, () => randomUUID());
    const admissions = workItemIds.map((id) => admit(id, 7));

    expect(admissions.filter((result) => result.kind === "admitted")).toHaveLength(2);
    expect(admissions.filter((result) => result.kind === "throttled")).toHaveLength(3);
    const throttled = admissions.filter((result) => result.kind === "throttled");
    expect(throttled.every((result) => result.reason === "actor_outstanding")).toBe(true);
    expect(buckets(actorScopeKey(INSTALLATION_ID, 7))[0]?.outstanding_count).toBe(2);

    const admittedId = workItemIds.find((_id, index) => admissions[index]?.kind === "admitted");
    if (admittedId === undefined) throw new Error("no admitted work item");
    runToCompleted(admittedId);

    const retry = admit(randomUUID(), 7);
    expect(retry.kind).toBe("admitted");
  });

  it("keeps quota state through non-terminal status transitions", () => {
    const workItemId = randomUUID();
    expect(admit(workItemId, 7).kind).toBe("admitted");

    const keys = [actorScopeKey(INSTALLATION_ID, 7), installationScopeKey(INSTALLATION_ID)];
    const before = buckets(...keys);
    const reservationBefore = reservation(workItemId);

    runToRunning(workItemId);
    scheduleWorkRunRetry(db, {
      workId: workItemId,
      attemptNo: 1,
      errorJson: JSON.stringify({ message: "retry later" }),
      nextRetryAt: Date.now() + 60_000,
      now: Date.now(),
    });

    expect(buckets(...keys)).toEqual(before);
    expect(reservation(workItemId)).toEqual(reservationBefore);
    expect(reservation(workItemId)?.released_at).toBeNull();
  });

  it("releases a quota reservation only once across terminal updates", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config)).toMatchObject({ kind: "admitted" });

    runToCompleted(workItemId);
    const firstBuckets = buckets(
      actorScopeKey(INSTALLATION_ID, 7),
      repositoryScopeKey(INSTALLATION_ID, OWNER, REPO),
      installationScopeKey(INSTALLATION_ID),
    );
    const firstReservation = reservation(workItemId);

    immediate(db, () =>
      markWorkRunFailed(db, {
        workId: workItemId,
        attemptNo: 1,
        errorJson: JSON.stringify({ message: "second terminal update" }),
        now: Date.now(),
      }),
    );
    const secondBuckets = buckets(
      actorScopeKey(INSTALLATION_ID, 7),
      repositoryScopeKey(INSTALLATION_ID, OWNER, REPO),
      installationScopeKey(INSTALLATION_ID),
    );
    const secondReservation = reservation(workItemId);

    expect(secondBuckets).toEqual(firstBuckets);
    expect(secondReservation).toEqual(firstReservation);
    expect(firstBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "installation",
          outstanding_count: 0,
          provider_tokens_used: 6,
        }),
      ]),
    );
    expect(firstReservation?.released_at).not.toBeNull();
    expect(firstReservation?.reserved_provider_tokens).toBe(0);
  });

  it("keeps provider reservations safe for exact and unknown usage", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const firstId = randomUUID();
    expect(admit(firstId, 7, config)).toMatchObject({
      kind: "admitted",
      providerReservationTokens: 6,
    });

    expect(admit(randomUUID(), 8, config)).toEqual({
      kind: "throttled",
      reason: "provider_budget",
    });

    recordAskProviderUsage(db, {
      workItemId: firstId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });
    const afterExactUsageId = randomUUID();
    expect(admit(afterExactUsageId, 8, config).kind).toBe("admitted");

    runToCompleted(firstId);
    runToCompleted(afterExactUsageId);

    expect(admit(randomUUID(), 9, config)).toEqual({
      kind: "throttled",
      reason: "provider_budget",
    });
  });

  it("rolls an expired provider window under concurrent admissions", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 4,
    };
    const straddlerId = randomUUID();
    expect(admit(straddlerId, 7, config)).toMatchObject({
      kind: "admitted",
      providerReservationTokens: 4,
    });

    db.prepare(
      `UPDATE ask_quota_buckets
          SET provider_tokens_used = 8,
              provider_window_started_at = ?
        WHERE scope = 'installation' AND scope_key = ?`,
    ).run(
      Date.now() - config.providerBudgetWindowSeconds * 1000,
      installationScopeKey(INSTALLATION_ID),
    );

    const admissions = [admit(randomUUID(), 8, config), admit(randomUUID(), 9, config)];

    expect(admissions.filter((result) => result.kind === "admitted")).toHaveLength(1);
    expect(admissions.filter((result) => result.kind === "throttled")).toHaveLength(1);
    expect(admissions.find((result) => result.kind === "throttled")).toEqual({
      kind: "throttled",
      reason: "provider_budget",
    });

    const installation = buckets(installationScopeKey(INSTALLATION_ID))[0];
    expect(installation).toMatchObject({
      provider_tokens_used: 0,
      provider_tokens_reserved: 8,
    });
    expect(installation?.provider_window_started_at ?? 0).toBeGreaterThan(Date.now() - 10_000);

    const straddler = reservation(straddlerId);
    expect(straddler).toMatchObject({
      reserved_provider_tokens: 4,
      released_at: null,
    });
  });

  it("accounts distinct executions once and refuses a later reservation", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");

    const firstExecution = createAskExecutionId();
    const secondExecution = createAskExecutionId();
    for (const [executionId, totalTokens] of [
      [firstExecution, 4],
      [secondExecution, 9],
      [firstExecution, 4],
      [secondExecution, 9],
    ] as const) {
      recordAskProviderUsage(db, { workItemId, executionId, totalTokens });
    }

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]).toMatchObject({
      provider_tokens_used: 13,
      provider_tokens_reserved: 0,
    });
    expect(admit(randomUUID(), 8, config)).toEqual({
      kind: "throttled",
      reason: "provider_budget",
    });
  });

  it("serializes duplicate receipts and counts distinct concurrent executions", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 20,
      providerReservationTokens: 6,
    };
    const duplicateId = randomUUID();
    const distinctId = randomUUID();
    expect(admit(duplicateId, 7, config).kind).toBe("admitted");
    expect(admit(distinctId, 8, config).kind).toBe("admitted");

    const duplicateExecution = createAskExecutionId();
    recordAskProviderUsage(db, {
      workItemId: duplicateId,
      executionId: duplicateExecution,
      totalTokens: 4,
    });
    recordAskProviderUsage(db, {
      workItemId: duplicateId,
      executionId: duplicateExecution,
      totalTokens: 4,
    });

    recordAskProviderUsage(db, {
      workItemId: distinctId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });
    recordAskProviderUsage(db, {
      workItemId: distinctId,
      executionId: createAskExecutionId(),
      totalTokens: 9,
    });

    const used = readRows(
      db
        .prepare(
          `SELECT work_item_id, provider_tokens_used FROM ask_quota_reservations
          WHERE work_item_id IN (?, ?) ORDER BY provider_tokens_used`,
        )
        .all(duplicateId, distinctId),
      v.object({ work_item_id: v.string(), provider_tokens_used: v.number() }),
    );
    expect(used).toEqual([
      { work_item_id: duplicateId, provider_tokens_used: 4 },
      { work_item_id: distinctId, provider_tokens_used: 13 },
    ]);
  });

  it("rejects a conflicting final report without changing the prior charge", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    const executionId = createAskExecutionId();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");
    recordAskProviderUsage(db, { workItemId, executionId, totalTokens: 4 });

    expect(() => recordAskProviderUsage(db, { workItemId, executionId, totalTokens: 9 })).toThrow(
      AppError,
    );

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]?.provider_tokens_used).toBe(4);
  });

  it("reconciles a delayed receipt without reopening outstanding work", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");

    runToCompleted(workItemId);

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]).toMatchObject({
      outstanding_count: 0,
      provider_tokens_used: 6,
    });

    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });
    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 9,
    });

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]).toEqual(
      expect.objectContaining({
        outstanding_count: 0,
        provider_tokens_used: 13,
        provider_tokens_reserved: 0,
      }),
    );
  });

  it("keeps a conservative charge in an expired window off the new window", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");
    runToCompleted(workItemId);
    db.prepare(
      `UPDATE ask_quota_buckets
          SET provider_tokens_used = 0, provider_window_started_at = ?
        WHERE scope = 'installation' AND scope_key = ?`,
    ).run(Date.now() + 60_000, installationScopeKey(INSTALLATION_ID));

    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });
    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 9,
    });

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]).toEqual(
      expect.objectContaining({
        provider_tokens_used: 0,
        outstanding_count: 0,
      }),
    );
  });

  it("adds a new execution on top of a legacy known charge", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 20,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");
    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });
    db.prepare(`DELETE FROM ask_quota_execution_receipts WHERE work_item_id = ?`).run(workItemId);

    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 9,
    });

    expect(buckets(installationScopeKey(INSTALLATION_ID))[0]?.provider_tokens_used).toBe(13);
  });

  it("does not apply usage to another installation", () => {
    const config: AskQuotaConfig = {
      ...BASE_QUOTA,
      providerBudgetTokens: 10,
      providerReservationTokens: 6,
    };
    const workItemId = randomUUID();
    expect(admit(workItemId, 7, config).kind).toBe("admitted");
    recordAskProviderUsage(db, {
      workItemId,
      executionId: createAskExecutionId(),
      totalTokens: 4,
    });

    expect(buckets(installationScopeKey(1))).toEqual([]);
  });

  it("admits a slash /ask with a reservation carrying the trigger comment", () => {
    const result = slashAsk(301, 1301, "ask-301");
    const runs = askRuns("o/r#301");
    expect(runs).toHaveLength(1);
    expect(result.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    const reserved = triggerReservations().find((row) => row.work_item_id === runs[0]?.work_id);
    expect(reserved?.trigger_comment_id).toBe(1301);
  });

  it("retains the mention: a second ask on the same comment is skipped", () => {
    slashAsk(302, 1302, "ask-302-a");
    const second = slashAsk(302, 1302, "ask-302-b");
    const runs = askRuns("o/r#302");
    expect(runs).toHaveLength(1);
    expect(second.events.some((e) => e.name === "agent_work_enqueued")).toBe(false);
    expect(triggerReservations().filter((row) => row.trigger_comment_id === 1302)).toHaveLength(1);
  });

  it("acks a missing question with a usage hint", () => {
    slashAsk(303, 1303, "ask-303", "/ask");
    const acks = readRows(
      db
        .prepare(`SELECT payload_json FROM work_runs WHERE pr_key = 'o/r#303' AND kind = 'ack'`)
        .all(),
      v.object({ payload_json: v.string() }),
    );
    expect(acks.length).toBeGreaterThan(0);
    expect(acks[0]?.payload_json).toContain("reply");
  });
});
