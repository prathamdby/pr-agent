import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { runRetention } from "../../src/state/retention.ts";
import { readRows } from "../../src/state/db.ts";
import {
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  RETENTION_DELETE_BATCH_SIZE,
} from "../../src/settings/index.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { openSqliteAppState } from "./db.ts";

const RETENTION = makeTestConfig({
  retention: { agentWorkSeconds: 30 * 86_400, webhookEventsSeconds: 30 * 86_400 },
  agentEvents: { retentionSeconds: 0 },
});
const daysAgo = (n: number) => Date.now() - n * 86_400_000;

const state = openSqliteAppState();
const db = state.db;
let seq = 0;

afterAll(() => {
  state.close();
});

afterEach(() => {
  for (const table of [
    "work_runs",
    "work_run_attempts",
    "webhook_deliveries",
    "webhook_body_replays",
    "webhook_rejections",
    "pr_state",
    "pr_head_ci_state",
    "github_repository_capabilities",
    "agent_feedback",
    "publish_intents",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

function insertRun(status: string, updatedAt: number, prKey = "o/r#1", headSha = "h") {
  seq += 1;
  const workId = `retention-${String(seq)}`;
  db.prepare(
    `INSERT INTO work_runs
      (work_id, pr_key, kind, lane, lane_epoch, status, current_attempt_no, payload_json, created_at, updated_at)
     VALUES (?, ?, 'review', 'review', 0, ?, 1, ?, ?, ?)`,
  ).run(workId, prKey, status, JSON.stringify({ headSha }), updatedAt, updatedAt);
  db.prepare(
    `INSERT INTO work_run_attempts (work_id, attempt_no, attempt_id, status, started_at)
     VALUES (?, 1, ?, 'completed', ?)`,
  ).run(workId, `${workId}-a1`, updatedAt);
  return workId;
}

const ids = (sql: string, ...params: readonly (string | number)[]) =>
  readRows(db.prepare(sql).all(...params), v.object({ id: v.string() })).map((row) => row.id);

describe("retention (sqlite)", () => {
  it("deletes aged terminal work runs but keeps fresh and non-terminal", () => {
    const aged = insertRun("completed", daysAgo(60));
    const fresh = insertRun("completed", daysAgo(1));
    const agedQueued = insertRun("pending_dispatch", daysAgo(60));
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.workRunsDeleted).toBe(1);
    const remaining = ids(`SELECT work_id AS id FROM work_runs`);
    expect(remaining).not.toContain(aged);
    expect(remaining).toContain(fresh);
    expect(remaining).toContain(agedQueued);
  });

  it("uses updated_at for superseded work runs", () => {
    const agedSuperseded = insertRun("superseded", daysAgo(60));
    const freshSuperseded = insertRun("superseded", daysAgo(1));
    runRetention(db, RETENTION, Date.now());
    const remaining = ids(`SELECT work_id AS id FROM work_runs`);
    expect(remaining).not.toContain(agedSuperseded);
    expect(remaining).toContain(freshSuperseded);
  });

  it("cascades an aged work run's attempt rows and keeps the fresh attempts", () => {
    const aged = insertRun("completed", daysAgo(60));
    const fresh = insertRun("completed", daysAgo(1));
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.workRunAttemptsDeleted).toBe(1);
    expect(ids(`SELECT work_id AS id FROM work_run_attempts`)).toEqual([fresh]);
    expect(ids(`SELECT work_id AS id FROM work_run_attempts`)).not.toContain(aged);
  });

  it("deletes aged webhook deliveries and body replays but keeps fresh ones", () => {
    for (const [key, at] of [
      ["delivery:aged", daysAgo(60)],
      ["delivery:fresh", Date.now()],
    ] as const) {
      db.prepare(
        `INSERT INTO webhook_deliveries (delivery_key, body_hash, status, created_at) VALUES (?, ?, 'processed', ?)`,
      ).run(key, `hash-${key}`, at);
      db.prepare(
        `INSERT INTO webhook_body_replays (body_hash, delivery_key, created_at) VALUES (?, ?, ?)`,
      ).run(`hash-${key}`, key, at);
    }
    runRetention(db, RETENTION, Date.now());
    expect(ids(`SELECT delivery_key AS id FROM webhook_deliveries`)).toEqual(["delivery:fresh"]);
    expect(ids(`SELECT delivery_key AS id FROM webhook_body_replays`)).toEqual(["delivery:fresh"]);
  });

  it("clears approval records by last update and preserves fresh rows across all states", () => {
    for (const approval of ["awaiting", "approved", "withdrawn"]) {
      for (const [suffix, at] of [
        ["old", daysAgo(60)],
        ["fresh", Date.now()],
      ] as const) {
        db.prepare(
          `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, approval_json, updated_at)
           VALUES (?, 'open', ?, ?, ?)`,
        ).run(`o/r#${approval}-${suffix}`, at, JSON.stringify({ state: approval }), at);
      }
    }
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.reviewApprovalsCleared).toBe(3);
    expect(
      ids(`SELECT pr_key AS id FROM pr_state WHERE approval_json IS NOT NULL ORDER BY pr_key`),
    ).toEqual(["o/r#approved-fresh", "o/r#awaiting-fresh", "o/r#withdrawn-fresh"]);
  });

  it("purges rejected-arrival evidence across batches using each arrival's age", () => {
    const insert = db.prepare(
      `INSERT INTO webhook_rejections (delivery_key, metadata_json, created_at) VALUES ('body:a', '{}', ?)`,
    );
    for (let index = 0; index < RETENTION_DELETE_BATCH_SIZE + 1; index += 1)
      insert.run(daysAgo(60));
    insert.run(Date.now());
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.webhookRowsDeleted).toBe(RETENTION_DELETE_BATCH_SIZE + 1);
    expect(ids(`SELECT CAST(id AS TEXT) AS id FROM webhook_rejections`)).toHaveLength(1);
    runRetention(db, RETENTION, Date.now());
    expect(ids(`SELECT CAST(id AS TEXT) AS id FROM webhook_rejections`)).toHaveLength(1);
  });

  it("deletes aged head CI state unless an active work run still covers that head", () => {
    insertRun("running", daysAgo(1), "o/r#1", "h");
    for (const [head, at] of [
      ["orphan-aged", daysAgo(60)],
      ["h", daysAgo(60)],
      ["fresh", Date.now()],
    ] as const) {
      db.prepare(
        `INSERT INTO pr_head_ci_state (repo_key, head_sha, installation_id, state_json, sources_json, updated_at)
         VALUES ('o/r', ?, 1, '{}', '{}', ?)`,
      ).run(head, at);
    }
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.prHeadCiStateDeleted).toBe(1);
    const heads = ids(`SELECT head_sha AS id FROM pr_head_ci_state`);
    expect(heads).not.toContain("orphan-aged");
    expect(heads).toContain("h");
    expect(heads).toContain("fresh");
  });

  it("expires orphaned capability observations and keeps repositories with work", () => {
    insertRun("completed", daysAgo(1), "o/r#1");
    for (const [repo, at] of [
      ["o/orphan", daysAgo(60)],
      ["o/r", daysAgo(60)],
      ["o/fresh", Date.now()],
    ] as const) {
      db.prepare(
        `INSERT INTO github_repository_capabilities (installation_id, repo_key, capabilities_json, generation, updated_at)
         VALUES (1, ?, '{}', 1, ?)`,
      ).run(repo, at);
    }
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.capabilitiesDeleted).toBe(1);
    expect(
      ids(`SELECT repo_key AS id FROM github_repository_capabilities ORDER BY repo_key`),
    ).toEqual(["o/fresh", "o/r"]);
  });

  it("deletes agent_feedback older than the default retention and keeps it when retention is 0", () => {
    const insert = db.prepare(
      `INSERT INTO agent_feedback (work_id, pr_key, kind, payload_json, created_at)
       VALUES (?, 'o/r#1', 'tool', '{}', ?)`,
    );
    insert.run("aged", daysAgo(31));
    insert.run("fresh", daysAgo(1));
    const deleted = runRetention(
      db,
      {
        ...RETENTION,
        agentEvents: {
          ...RETENTION.agentEvents,
          retentionSeconds: DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
        },
      },
      Date.now(),
    );
    expect(deleted.agentFeedbackDeleted).toBe(1);
    expect(ids(`SELECT work_id AS id FROM agent_feedback`)).toEqual(["fresh"]);
    insert.run("kept", daysAgo(31));
    const keptRun = runRetention(db, RETENTION, Date.now());
    expect(keptRun.agentFeedbackDeleted).toBe(0);
    expect(ids(`SELECT work_id AS id FROM agent_feedback`)).toContain("kept");
  });

  it("deletes aged settled publish intents but never a mutating or recoverable one", () => {
    const insert = db.prepare(
      `INSERT INTO publish_intents
        (intent_key, pr_key, work_id, resource_target, operation_key, state, mutation_kind, identity_json, updated_at)
       VALUES (?, 'o/r#1', 'w', 'comment:1', ?, ?, 'comment', '{}', ?)`,
    );
    insert.run("aged-reconciled", "op1", "reconciled", daysAgo(60));
    insert.run("aged-mutating", "op2", "mutating", daysAgo(60));
    insert.run("aged-recoverable", "op3", "outcome_unknown_recoverable", daysAgo(60));
    insert.run("fresh-reconciled", "op4", "reconciled", Date.now());
    const result = runRetention(db, RETENTION, Date.now());
    expect(result.publishIntentsDeleted).toBe(1);
    expect(ids(`SELECT intent_key AS id FROM publish_intents ORDER BY intent_key`)).toEqual([
      "aged-mutating",
      "aged-recoverable",
      "fresh-reconciled",
    ]);
  });
});
