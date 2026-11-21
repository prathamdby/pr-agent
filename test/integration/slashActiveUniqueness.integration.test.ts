import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import type { PrRef, WebhookHeaders } from "../../src/agentWork/types.ts";
import type { SlashCommandInput } from "../../src/agentWork/types.ts";
import {
  DESCRIPTION_ALREADY_IN_PROGRESS,
  TRIAGE_ALREADY_IN_PROGRESS,
  TRIAGE_FULL_RUN_IN_PROGRESS,
} from "../../src/settings/index.ts";
import { ensurePrState, runDelivery, type IntakeFeatures } from "../../src/state/intake.ts";
import { claimDispatchableWorkRun, insertWorkRun } from "../../src/state/workRuns.ts";
import { readRows } from "../../src/state/db.ts";
import { openSqliteAppState } from "./db.ts";

const FEATURES: IntakeFeatures = {
  review: "auto",
  reviewCadence: "once",
  describe: "auto",
  verification: "auto",
  ask: "manual",
  triage: "manual",
};

const OWNER = "slash-uniq-it";

const state = openSqliteAppState();
const db = state.db;

afterAll(() => {
  state.close();
});

afterEach(() => {
  db.prepare(`DELETE FROM work_run_attempts`).run();
  db.prepare(`DELETE FROM work_runs`).run();
  db.prepare(`DELETE FROM pr_state`).run();
  db.prepare(`DELETE FROM publish_records`).run();
  db.prepare(`DELETE FROM webhook_rejections`).run();
  db.prepare(`DELETE FROM webhook_body_replays`).run();
  db.prepare(`DELETE FROM webhook_deliveries`).run();
});

const SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY =
  "A `/review` run is already queued or in progress for this pull request.";
const SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY =
  "A `/verify` run is already queued or in progress for this pull request.";
const SLASH_REVIEW_FORCE_RESTARTED_BODY =
  "Cancelled the previous review and started a new one on the latest commit.";

const runRowSchema = v.object({
  work_id: v.string(),
  kind: v.string(),
  status: v.string(),
  payload_json: v.string(),
});

const ackPayloadSchema = v.looseObject({
  delivery: v.optional(v.string()),
  workItemId: v.optional(v.string()),
  reply: v.optional(v.looseObject({ target: v.unknown(), body: v.string() })),
  progress: v.optional(v.looseObject({ lens: v.string(), source: v.string() })),
  cancelProgress: v.optional(
    v.looseObject({
      workItemId: v.string(),
      cancelledWorkItemIds: v.array(v.string()),
      attribution: v.optional(v.looseObject({ kind: v.string(), login: v.string() })),
    }),
  ),
});

function runs(prKey: string, kind?: string) {
  return readRows(
    kind === undefined
      ? db.prepare(`SELECT * FROM work_runs WHERE pr_key = ?`).all(prKey)
      : db.prepare(`SELECT * FROM work_runs WHERE pr_key = ? AND kind = ?`).all(prKey, kind),
    runRowSchema,
  );
}

function acks(prKey: string) {
  return runs(prKey, "ack").map((row) => ({
    workId: row.work_id,
    data: v.parse(ackPayloadSchema, JSON.parse(row.payload_json)),
  }));
}

function ackForDelivery(prKey: string, delivery: string) {
  const found = acks(prKey).find((ack) => ack.data.delivery === delivery);
  if (found === undefined) throw new Error(`no ack run for delivery ${delivery}`);
  return found.data;
}

function slash(
  input: Partial<SlashCommandInput> & {
    readonly repo: string;
    readonly prNumber: number;
    readonly command: string;
    readonly delivery: string;
  },
) {
  const headers: WebhookHeaders = {
    delivery: input.delivery,
    event: "issue_comment",
    rawBody: Buffer.from(
      input.headers?.rawBody ?? JSON.stringify({ repo: input.repo, d: input.delivery }),
    ),
  };
  const full: SlashCommandInput = {
    headers,
    installationId: 4242,
    owner: OWNER,
    repo: input.repo,
    prNumber: input.prNumber,
    commentId: input.commentId ?? 1000,
    commenterId: input.commenterId ?? 11,
    commenterLogin: input.commenterLogin ?? "alice",
    body: input.body ?? `/${input.command}`,
    command: input.command,
    replyTarget: input.replyTarget ?? { kind: "prConversation", prNumber: input.prNumber },
    ...(input.triageScope !== undefined ? { triageScope: input.triageScope } : {}),
    ...(input.threadAnchorCommentId !== undefined
      ? { threadAnchorCommentId: input.threadAnchorCommentId }
      : {}),
    ...(input.needsThreadRootResolution !== undefined
      ? { needsThreadRootResolution: input.needsThreadRootResolution }
      : {}),
  };
  return runDelivery(db, { features: FEATURES }, { kind: "slash", input: full });
}

function seedRun(
  prKey: string,
  kind: "review" | "description" | "triage" | "verification" | "ask",
  status: "pending_dispatch" | "running" | "completed" | "failed" | "cancelled",
  payloadExtra: Record<string, unknown>,
) {
  const workId = randomUUID();
  insertWorkRun(db, {
    workId,
    prKey,
    kind,
    payloadJson: JSON.stringify({ headSha: "sha-old", ...payloadExtra }),
    now: Date.now(),
  });
  if (status !== "pending_dispatch") {
    db.prepare(`UPDATE work_runs SET status = ? WHERE work_id = ?`).run(status, workId);
  }
  return workId;
}

function key(repo: string, prNumber: number) {
  return `${OWNER}/${repo}#${prNumber}`;
}

const KIND_OF = {
  review: "review",
  description: "description",
  triage: "triage",
  verification: "verification",
} as const;
const COMMAND_OF = {
  review: "review",
  description: "describe",
  triage: "triage",
  verification: "verify",
} as const;
const BUSY_BODY = {
  review: SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY,
  description: DESCRIPTION_ALREADY_IN_PROGRESS,
  triage: TRIAGE_ALREADY_IN_PROGRESS,
  verification: SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY,
} as const;

type WorkType = keyof typeof KIND_OF;

function terminalize(prKey: string, type: WorkType, workId: string) {
  const status = type === "review" || type === "triage" ? "cancelled" : "completed";
  db.prepare(`UPDATE work_runs SET status = ? WHERE work_id = ?`).run(status, workId);
  if (type === "review") {
    db.prepare(
      `UPDATE pr_state SET active_review_work_id = NULL, active_review_source = NULL WHERE pr_key = ?`,
    ).run(prKey);
  }
}

function makeFailTrigger(when: string) {
  const name = `fail_${when.replace(/[^a-z0-9]/gi, "_")}`;
  db.exec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON work_runs WHEN ${when}
     BEGIN SELECT RAISE(ABORT, 'injected intake failure'); END`,
  );
  return () => db.exec(`DROP TRIGGER ${name}`);
}

describe("slash active uniqueness (sqlite)", () => {
  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((type) =>
      (["queued", "running"] as const).map((status) => ({ type, status })),
    ),
  )("keeps $type intake when its $status winner races cancellation", ({ type, status }) => {
    const repo = `winner-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 77);
    const command = COMMAND_OF[type];
    const kind = KIND_OF[type];
    const winnerDelivery = `${repo}-winner`;
    const loserDelivery = `${repo}-loser`;

    const first = slash({
      repo,
      prNumber: 77,
      command,
      delivery: winnerDelivery,
      commentId: 1000,
      commenterId: 11,
      body: `/${command}\nRequest 0`,
    });
    expect(first.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    const winner = runs(prKey, kind)[0];
    if (winner === undefined) throw new Error("no admitted winner run");
    if (status === "running") {
      db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(winner.work_id);
    }
    const progressBefore = readRows(
      db.prepare(`SELECT work_id, payload_json FROM publish_records WHERE pr_key = ?`).all(prKey),
      v.object({ work_id: v.string(), payload_json: v.string() }),
    );

    const loser = slash({
      repo,
      prNumber: 77,
      command,
      delivery: loserDelivery,
      commentId: 1001,
      commenterId: 12,
      commenterLogin: "bob",
      body: `/${command}\nRequest 1`,
    });
    expect(loser.events.some((e) => e.name === "agent_work_enqueued")).toBe(false);
    const workRows = runs(prKey, kind);
    expect(workRows).toHaveLength(1);
    expect(workRows[0]?.work_id).toBe(winner.work_id);
    expect(
      readRows(
        db.prepare(`SELECT work_id, payload_json FROM publish_records WHERE pr_key = ?`).all(prKey),
        v.object({ work_id: v.string(), payload_json: v.string() }),
      ),
    ).toEqual(progressBefore);

    const siblingKey = key(`${repo}-sibling`, 77);
    slash({
      repo: `${repo}-sibling`,
      prNumber: 77,
      command,
      delivery: `${repo}-sibling`,
      commentId: 1001,
      commenterId: 12,
      body: `/${command}`,
    });
    expect(runs(siblingKey, kind)).toHaveLength(1);

    const loserAck = ackForDelivery(prKey, loserDelivery);
    expect(loserAck.reply?.body).toBe(BUSY_BODY[type]);
    expect(loserAck.workItemId).toBeUndefined();

    for (const delivery of [loserDelivery, randomUUID()]) {
      const replay = slash({
        repo,
        prNumber: 77,
        command,
        delivery,
        commentId: 1001,
        commenterId: 12,
        body: `/${command}\nRequest 1`,
        headers: {
          event: "issue_comment",
          delivery,
          rawBody: Buffer.from(JSON.stringify({ repo, d: loserDelivery })),
        },
      });
      expect(replay.events.some((e) => e.name === "deduped_delivery")).toBe(true);
    }
    expect(runs(prKey, kind)).toHaveLength(1);

    terminalize(prKey, type, winner.work_id);
    expect(runs(prKey, kind)[0]?.status).toBe(
      type === "review" || type === "triage" ? "cancelled" : "completed",
    );
    const ackCount = acks(prKey).length;
    expect(ackCount).toBe(2);
  });

  it("keeps the triage reply when cancellation races the resolved winner's payload read", () => {
    const repo = `triage-winner-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 77);
    slash({ repo, prNumber: 77, command: "triage", delivery: "triage-full", commentId: 1000 });
    const incoming = slash({
      repo,
      prNumber: 77,
      command: "triage",
      delivery: "triage-thread",
      commentId: 1001,
      triageScope: "thread",
      threadAnchorCommentId: 1001,
      replyTarget: { kind: "inlineReviewThread", prNumber: 77, inReplyToCommentId: 1001 },
    });
    expect(incoming.events.some((e) => e.name === "agent_work_enqueued")).toBe(false);
    expect(runs(prKey, "triage")).toHaveLength(1);
    const ack = ackForDelivery(prKey, "triage-thread");
    expect(ack.reply?.body).toBe(TRIAGE_FULL_RUN_IN_PROGRESS);
  });

  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((type) =>
      [false, true].map((wait) => ({ type, wait })),
    ),
  )("creates fresh $type work after a terminal winner (wait=$wait)", ({ type, wait }) => {
    void wait;
    const repo = `terminal-first-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 77);
    const command = COMMAND_OF[type];
    const kind = KIND_OF[type];

    slash({ repo, prNumber: 77, command, delivery: `${repo}-a`, commentId: 1000 });
    const predecessor = runs(prKey, kind)[0];
    if (predecessor === undefined) throw new Error("no predecessor run");
    terminalize(prKey, type, predecessor.work_id);

    slash({ repo, prNumber: 77, command, delivery: `${repo}-b`, commentId: 1001 });
    const items = runs(prKey, kind);
    expect(items).toHaveLength(2);
    expect(items.find((row) => row.work_id === predecessor.work_id)?.status).toBe(
      type === "review" || type === "triage" ? "cancelled" : "completed",
    );
    const fresh = items.find((row) => row.work_id !== predecessor.work_id);
    if (fresh === undefined) throw new Error("no fresh run");
    expect(fresh.status).toBe("pending_dispatch");
    const ack = ackForDelivery(prKey, `${repo}-b`);
    expect(ack.workItemId).toBe(fresh.work_id);
  });

  it("rolls back a resolved duplicate when its ack send fails and retries normally", () => {
    const repo = `winner-rollback-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 77);
    slash({ repo, prNumber: 77, command: "describe", delivery: `${repo}-a`, commentId: 1000 });
    const before = runs(prKey);
    const incoming: Parameters<typeof slash>[0] = {
      repo,
      prNumber: 77,
      command: "describe",
      delivery: `${repo}-b`,
      commentId: 1001,
    };

    const drop = makeFailTrigger("NEW.kind = 'ack'");
    try {
      expect(() => slash(incoming)).toThrow("injected intake failure");
    } finally {
      drop();
    }
    expect(runs(prKey)).toEqual(before);
    const deliveryRows = readRows(
      db
        .prepare(`SELECT delivery_key FROM webhook_deliveries WHERE delivery_key = ?`)
        .all(`delivery:${repo}-b`),
      v.object({ delivery_key: v.string() }),
    );
    expect(deliveryRows).toHaveLength(0);

    slash(incoming);
    expect(runs(prKey, "description")).toHaveLength(1);
    const ack = ackForDelivery(prKey, `${repo}-b`);
    expect(ack.reply?.body).toBe(DESCRIPTION_ALREADY_IN_PROGRESS);
    expect(ack.workItemId).toBeUndefined();
    expect(
      readRows(
        db
          .prepare(`SELECT delivery_key FROM webhook_deliveries WHERE delivery_key = ?`)
          .all(`delivery:${repo}-b`),
        v.object({ delivery_key: v.string() }),
      ),
    ).toHaveLength(1);
  });

  it("concurrent same-scope /describe deliveries create one work item and one work job", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 77);
    for (const [index, delivery] of ["d-a", "d-b", "d-c"].entries()) {
      slash({ repo, prNumber: 77, command: "describe", delivery, commentId: 1000 + index });
    }
    const items = runs(prKey, "description").filter((row) =>
      row.payload_json.includes('"source":"slash"'),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("pending_dispatch");
    const ackRows = acks(prKey);
    expect(ackRows).toHaveLength(3);
    expect(ackRows.filter((ack) => ack.data.workItemId === items[0]?.work_id)).toHaveLength(1);
    const losers = ackRows.filter(
      (ack) => ack.data.workItemId == null && ack.data.reply?.body?.includes("already"),
    );
    expect(losers).toHaveLength(2);
  });

  it("concurrent /verify deliveries create one work item and one work job", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 78);
    for (const [index, delivery] of ["v-a", "v-b", "v-c"].entries()) {
      slash({ repo, prNumber: 78, command: "verify", delivery, commentId: 2000 + index });
    }
    const items = runs(prKey, "verification").filter((row) =>
      row.payload_json.includes('"source":"slash"'),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("pending_dispatch");
    const ackRows = acks(prKey);
    expect(ackRows).toHaveLength(3);
    expect(ackRows.filter((ack) => ack.data.workItemId === items[0]?.work_id)).toHaveLength(1);
    expect(
      ackRows.filter(
        (ack) => ack.data.workItemId == null && ack.data.reply?.body?.includes("already"),
      ),
    ).toHaveLength(2);
  });

  it("slash /review enqueues a fresh review beside a failed prior job", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 55);
    const failedId = seedRun(prKey, "review", "failed", { source: "auto" });

    slash({ repo, prNumber: 55, command: "review", delivery: "slash-clear-1", commentId: 5500 });

    const queued = runs(prKey, "review").filter((row) => row.status === "pending_dispatch");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.work_id).not.toBe(failedId);
    expect(runs(prKey, "review").find((row) => row.work_id === failedId)?.status).toBe("failed");
  });

  it("/review force cancels the active review and enqueues a replacement in one tx", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 44);
    const oldId = seedRun(prKey, "review", "running", { source: "slash" });

    const result = slash({
      repo,
      prNumber: 44,
      command: "review",
      delivery: "force-1",
      commentId: 4400,
      commenterLogin: "alice",
      body: "/review force",
    });
    expect(
      result.events.some(
        (e) => e.name === "agent_work_cancel_requested" && e.fields?.force === true,
      ),
    ).toBe(true);

    const rows = runs(prKey, "review").filter((row) =>
      row.payload_json.includes('"source":"slash"'),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.work_id === oldId)?.status).toBe("cancelled");
    const fresh = rows.find((row) => row.work_id !== oldId);
    if (fresh === undefined) throw new Error("no replacement run");
    expect(fresh.status).toBe("pending_dispatch");

    const ack = ackForDelivery(prKey, "force-1");
    expect(ack.workItemId).toBe(fresh.work_id);
    expect(ack.progress).toMatchObject({ lens: "review", source: "slash" });
    expect(ack.cancelProgress?.workItemId).toBe(oldId);
    expect(ack.cancelProgress?.cancelledWorkItemIds).toEqual([oldId]);
    expect(ack.reply?.body).toContain("latest commit");
  });

  it.each([
    { prior: "empty", first: "/review force", second: "/review force" },
    { prior: "queued", first: "/review force", second: "/review force" },
    { prior: "running", first: "/review force", second: "/review force" },
    { prior: "empty", first: "/review", second: "/review force" },
    { prior: "empty", first: "/review force", second: "/review" },
  ])("serializes $first then $second with a $prior predecessor", ({ prior, first, second }) => {
    const repo = `race-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 44);
    let priorId: string | undefined;
    if (prior !== "empty") {
      priorId = seedRun(prKey, "review", prior === "running" ? "running" : "pending_dispatch", {
        source: "slash",
        mode: "review",
      });
      db.prepare(
        `INSERT INTO pr_state (pr_key, active_review_work_id, active_review_source, lifecycle_state, observed_at, updated_at)
         VALUES (?, ?, 'slash', 'open', 0, 0)
         ON CONFLICT (pr_key) DO UPDATE SET active_review_work_id = excluded.active_review_work_id, active_review_source = 'slash'`,
      ).run(prKey, priorId);
    }
    const inputs = [first, second].map((body, index) => ({
      repo,
      prNumber: 44,
      command: "review" as const,
      delivery: `${repo}-${index}`,
      commentId: 4400 + index,
      commenterId: 11 + index,
      commenterLogin: index === 0 ? "alice" : "bob",
      body,
    }));
    slash(inputs[0]!);
    const firstRun = runs(prKey, "review")
      .filter((row) => row.status === "pending_dispatch")
      .find((row) => row.work_id !== priorId);
    if (firstRun === undefined) throw new Error("first /review was not admitted");
    const firstId = firstRun.work_id;
    slash(inputs[1]!);

    const rows = runs(prKey, "review");
    const active = rows.filter(
      (row) => row.status === "pending_dispatch" || row.status === "running",
    );
    expect(active).toHaveLength(1);
    const survivorId = active[0]!.work_id;
    const ackRows = acks(prKey);
    expect(ackRows).toHaveLength(2);
    const firstAck = ackForDelivery(prKey, inputs[0]!.delivery);
    const secondAck = ackForDelivery(prKey, inputs[1]!.delivery);
    expect(firstAck.workItemId).toBe(firstId);
    expect(firstAck.progress).toMatchObject({ lens: "review", source: "slash" });
    if (second === "/review force") {
      expect(rows.find((row) => row.work_id === firstId)?.status).toBe("cancelled");
      expect(survivorId).not.toBe(firstId);
      expect(secondAck.workItemId).toBe(survivorId);
      expect(secondAck.cancelProgress?.cancelledWorkItemIds).toContain(firstId);
      expect(secondAck.reply?.body).toBe(SLASH_REVIEW_FORCE_RESTARTED_BODY);
      expect(
        ackRows.some((ack) => ack.data.reply?.body === SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY),
      ).toBe(false);
    } else {
      expect(survivorId).toBe(firstId);
      expect(secondAck.workItemId).toBeUndefined();
      expect(secondAck.reply?.body).toBe(SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY);
    }
    const progress = readRows(
      db
        .prepare(
          `SELECT work_id FROM publish_records WHERE pr_key = ? AND step = 'progress_comment'`,
        )
        .all(prKey),
      v.object({ work_id: v.string() }),
    );
    expect(progress[0]?.work_id).toBe(survivorId);
    if (prior !== "empty" && priorId !== undefined) {
      expect(rows.find((row) => row.work_id === priorId)?.status).toBe("cancelled");
      expect(firstAck.cancelProgress?.cancelledWorkItemIds).toContain(priorId);
      expect(firstAck.reply?.body).toBe(SLASH_REVIEW_FORCE_RESTARTED_BODY);
    }
  });

  it("/review force releases the cancelled holder's lease so the sole replacement can be claimed", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 44);
    const oldId = seedRun(prKey, "review", "running", { source: "slash" });
    const siblingKey = key(repo, 45);
    const siblingId = seedRun(siblingKey, "verification", "running", { source: "slash" });

    slash({
      repo,
      prNumber: 44,
      command: "review",
      delivery: "force-lease-1",
      commentId: 4401,
      commenterLogin: "alice",
      body: "/review force",
    });

    const rows = runs(prKey, "review");
    const replacement = rows.find(
      (row) => row.work_id !== oldId && row.status === "pending_dispatch",
    );
    if (replacement === undefined) throw new Error("no replacement run");
    expect(rows.find((row) => row.work_id === oldId)?.status).toBe("cancelled");
    expect(runs(siblingKey, "verification")[0]?.status).toBe("running");
    void siblingId;

    ensurePrState(db, prKey, Date.now());
    const claimed = claimDispatchableWorkRun(db, Date.now());
    expect(claimed?.run.work_id).toBe(replacement.work_id);
  });

  it("rolls back a forced replacement and retries without duplicating delivery work", () => {
    const repo = `rollback-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 44);
    slash({ repo, prNumber: 44, command: "review", delivery: `${repo}-plain`, commentId: 4400 });
    const predecessor = runs(prKey, "review")[0];
    if (predecessor === undefined) throw new Error("no predecessor review");
    const forcedDelivery = `${repo}-forced`;
    const forcedBody = JSON.stringify({ repo, body: "/review force" });
    const forcedInput: Parameters<typeof slash>[0] = {
      repo,
      prNumber: 44,
      command: "review",
      delivery: forcedDelivery,
      commentId: 4401,
      body: "/review force",
      headers: {
        event: "issue_comment",
        delivery: forcedDelivery,
        rawBody: Buffer.from(forcedBody),
      },
    };
    const initialAks = acks(prKey).length;
    const initialReviews = runs(prKey, "review").length;

    const drop = makeFailTrigger("NEW.kind = 'review'");
    try {
      expect(() => slash(forcedInput)).toThrow("injected intake failure");
    } finally {
      drop();
    }
    expect(runs(prKey, "review")).toEqual([predecessor]);
    expect(acks(prKey)).toHaveLength(initialAks);
    expect(runs(prKey, "review")).toHaveLength(initialReviews);
    expect(
      readRows(
        db
          .prepare(`SELECT delivery_key FROM webhook_deliveries WHERE delivery_key = ?`)
          .all(`delivery:${forcedDelivery}`),
        v.object({ delivery_key: v.string() }),
      ),
    ).toHaveLength(0);
    const progress = readRows(
      db
        .prepare(
          `SELECT work_id FROM publish_records WHERE pr_key = ? AND step = 'progress_comment'`,
        )
        .all(prKey),
      v.object({ work_id: v.string() }),
    );
    expect(progress[0]?.work_id).toBe(predecessor.work_id);

    slash(forcedInput);
    const committed = runs(prKey, "review");
    expect(committed.find((row) => row.work_id === predecessor.work_id)?.status).toBe("cancelled");
    expect(committed.filter((row) => row.status === "pending_dispatch")).toHaveLength(1);
    const retryAcks = acks(prKey).length;
    for (const delivery of [forcedDelivery, randomUUID()]) {
      const replay = slash({
        ...forcedInput,
        delivery,
        headers: {
          event: "issue_comment",
          delivery,
          rawBody: Buffer.from(forcedBody),
        },
      });
      expect(replay.events.some((e) => e.name === "deduped_delivery")).toBe(true);
      expect(runs(prKey, "review")).toEqual(committed);
      expect(acks(prKey)).toHaveLength(retryAcks);
    }
  });

  it("/review force leaves a sibling PR's active review untouched", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const key44 = key(repo, 44);
    const key45 = key(repo, 45);
    const key46 = key(repo, 46);
    const oldId = seedRun(key44, "review", "running", { source: "slash" });
    const siblingId = seedRun(key45, "review", "running", { source: "slash" });

    slash({
      repo,
      prNumber: 44,
      command: "review",
      delivery: "force-iso-1",
      commentId: 4401,
      commenterLogin: "alice",
      body: "/review force",
    });
    slash({
      repo,
      prNumber: 46,
      command: "review",
      delivery: "force-iso-2",
      commentId: 4601,
      body: "/review force",
    });

    const rows44 = runs(key44, "review");
    expect(rows44).toHaveLength(2);
    expect(rows44.find((row) => row.work_id === oldId)?.status).toBe("cancelled");
    expect(rows44.find((row) => row.work_id !== oldId)?.status).toBe("pending_dispatch");
    expect(runs(key45, "review")).toEqual([
      expect.objectContaining({ work_id: siblingId, status: "running" }),
    ]);
    expect(runs(key46, "review")).toEqual([
      expect.objectContaining({ status: "pending_dispatch" }),
    ]);
    const ack = ackForDelivery(key44, "force-iso-1");
    expect(ack.cancelProgress?.cancelledWorkItemIds).toEqual([oldId]);
  });

  it("keeps one review when a removed lens command arrives concurrently", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 88);
    const first = slash({
      repo,
      prNumber: 88,
      command: "review",
      delivery: "lens-review",
      commentId: 2000,
      body: "/review",
    });
    const second = slash({
      repo,
      prNumber: 88,
      command: "review-security",
      delivery: "lens-review-security",
      commentId: 2001,
      body: "/review-security",
    });
    expect(first.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    expect(second.events.some((e) => e.name === "ignored_unknown_slash_command")).toBe(true);
    const queued = runs(prKey, "review").filter((row) => row.status === "pending_dispatch");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload_json).toContain('"reviewLens":"review"');
  });

  it("does not uniqueness-block auto description inserts beside active slash work", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 99);
    slash({ repo, prNumber: 99, command: "describe", delivery: "auto-slash-1", commentId: 9900 });
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "pull_request",
        headers: {
          delivery: "auto-slash-open",
          event: "pull_request",
          rawBody: Buffer.from(JSON.stringify({ n: "auto-slash-open" })),
        },
        ref: {
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 99,
          headSha: "sha-auto",
        } satisfies PrRef,
        action: "opened",
      },
    );
    const items = runs(prKey, "description").filter((row) => row.status === "pending_dispatch");
    expect(items).toHaveLength(2);
    expect(items.map((row) => JSON.parse(row.payload_json).source).toSorted()).toEqual([
      "auto",
      "slash",
    ]);
  });

  it("allows a staleHeadRescheduled replacement while the parent remains running", () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const prKey = key(repo, 66);
    const parentId = seedRun(prKey, "review", "running", {
      source: "slash",
      mode: "review",
      staleHeadReplacementWorkItemId: "placeholder",
    });
    const replacementId = seedRun(prKey, "review", "pending_dispatch", {
      source: "slash",
      mode: "review",
      staleHeadRescheduled: true,
      staleHeadReplacementWorkItemId: "placeholder",
    });
    const rows = runs(prKey, "review");
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ work_id: parentId, status: "running" }),
        expect.objectContaining({ work_id: replacementId, status: "pending_dispatch" }),
      ]),
    );

    const refused = slash({
      repo,
      prNumber: 66,
      command: "review",
      delivery: "stale-head-review",
      commentId: 6600,
      body: "/review",
    });
    expect(refused.events.some((e) => e.name === "agent_work_enqueued")).toBe(false);
    const ack = ackForDelivery(prKey, "stale-head-review");
    expect(ack.reply?.body).toBe(SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY);
    expect(runs(prKey, "review")).toHaveLength(2);
  });
});
