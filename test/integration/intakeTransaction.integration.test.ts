import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as v from "valibot";
import type { PrRef, SlashCommandInput } from "../../src/agentWork/types.ts";
import { insertWebhookEvent, runDelivery, type IntakeFeatures } from "../../src/state/intake.ts";
import { acquireSingleWriterLock, immediate, openAppState, readRows } from "../../src/state/db.ts";
import { applyAppStateSchema } from "../../src/state/schema.ts";
import { createReviewRunner } from "../../src/agent/runtime/durable/reviewOrchestratorTask.ts";
import { openDurableRuntime } from "../../src/agent/runtime/durable/runtime.ts";
import { startDurableService } from "../../src/agent/runtime/durable/boot.ts";
import { archivePiDurableFiles } from "../../src/agent/runtime/durable/durableReset.ts";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.ts";
import { buildEffectWebhookLayer } from "../../src/effect/server.ts";
import { makeSqliteWebhookIntake, WebhookIntake } from "../../src/effect/webhookIntake.ts";
import { initEvlog } from "../../src/evlog.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { claimDispatchableWorkRun, insertWorkRun } from "../../src/state/workRuns.ts";
import { ASK_THROTTLED_BODY } from "../../src/settings/index.ts";
import { randomUUID } from "node:crypto";
import { openSqliteAppState } from "./db.ts";

const FEATURES: IntakeFeatures = {
  review: "auto",
  reviewCadence: "once",
  describe: "auto",
  verification: "auto",
  ask: "manual",
  triage: "manual",
};

const state = openSqliteAppState();
const db = state.db;

afterAll(() => {
  state.close();
});

const runRowSchema = v.object({
  work_id: v.string(),
  kind: v.string(),
  status: v.string(),
  payload_json: v.string(),
});

function runs(prKey: string, kind?: string) {
  return readRows(
    kind === undefined
      ? db.prepare(`SELECT * FROM work_runs WHERE pr_key = ?`).all(prKey)
      : db.prepare(`SELECT * FROM work_runs WHERE pr_key = ? AND kind = ?`).all(prKey, kind),
    runRowSchema,
  );
}

function deliveries() {
  return readRows(
    db.prepare(`SELECT delivery_key, status FROM webhook_deliveries`).all(),
    v.object({ delivery_key: v.string(), status: v.string() }),
  );
}

function headers(delivery: string, body?: string) {
  return {
    delivery,
    event: "pull_request",
    rawBody: Buffer.from(body ?? JSON.stringify({ n: delivery })),
  };
}

function ref(prNumber: number) {
  return {
    installationId: 1,
    owner: "o",
    repo: "r",
    prNumber,
    headSha: "sha-1",
  };
}

function pullRequest(ref_: PrRef, action: string, delivery: string, opts?: object) {
  return runDelivery(
    db,
    { features: FEATURES },
    {
      kind: "pull_request",
      headers: headers(delivery, JSON.stringify({ n: delivery })),
      ref: ref_,
      action,
      ...(opts !== undefined ? { opts } : {}),
    },
  );
}

describe("intake transaction (sqlite)", () => {
  it("admits an auto review on opened", () => {
    const r = ref(101);
    const result = pullRequest(r, "opened", "it-opened-101");
    const reviewRuns = runs("o/r#101", "review");
    expect(reviewRuns).toHaveLength(1);
    expect(reviewRuns[0]?.status).toBe("pending_dispatch");
    const payload = JSON.parse(reviewRuns[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload.source).toBe("auto");
    expect(payload.headSha).toBe("deferred-to-worker");
    expect(typeof payload.webhookReceivedAt).toBe("number");
    expect(
      result.events.some((e) => e.name === "agent_work_enqueued" && e.fields?.type === "review"),
    ).toBe(true);
    const prState = readRows(
      db.prepare(`SELECT active_review_work_id, active_review_source FROM pr_state`).all(),
      v.object({
        active_review_work_id: v.nullable(v.string()),
        active_review_source: v.nullable(v.string()),
      }),
    )[0];
    expect(prState?.active_review_work_id).toBe(reviewRuns[0]?.work_id);
    expect(prState?.active_review_source).toBe("auto");
  });

  it("enqueues a description on opened when describe is auto", () => {
    pullRequest(ref(102), "opened", "it-opened-102");
    expect(runs("o/r#102", "description")).toHaveLength(1);
  });

  it("dedupes a repeated delivery", () => {
    const r = ref(103);
    const body = JSON.stringify({ n: "same" });
    const first = runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "pull_request",
        headers: headers("it-dup-103", body),
        ref: r,
        action: "opened",
      },
    );
    const second = runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "pull_request",
        headers: headers("it-dup-103", body),
        ref: r,
        action: "opened",
      },
    );
    expect(first.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    expect(second.events.some((e) => e.name === "deduped_delivery")).toBe(true);
    expect(runs("o/r#103", "review")).toHaveLength(1);
    expect(deliveries().filter((row) => row.delivery_key === "delivery:it-dup-103")).toHaveLength(
      1,
    );
  });

  it("rolls back the whole delivery when a handler throws", () => {
    const r = ref(104);
    expect(() =>
      runDelivery(
        db,
        { features: FEATURES },
        {
          kind: "pull_request",
          headers: headers("it-close-104", JSON.stringify({ n: "close" })),
          ref: r,
          action: "closed",
        },
      ),
    ).toThrow("lifecycle observation");
    expect(deliveries().some((row) => row.delivery_key === "delivery:it-close-104")).toBe(false);
    expect(runs("o/r#104")).toHaveLength(0);
  });

  it("closed cancels active review and records lifecycle", () => {
    const r = ref(105);
    pullRequest(r, "opened", "it-opened-105");
    pullRequest(r, "closed", "it-closed-105", {
      lifecycle: { state: "closed", observedAt: "2024-01-01T00:00:00Z" },
    });
    const review = runs("o/r#105", "review")[0];
    expect(review?.status).toBe("cancelled");
    const lifecycle = readRows(
      db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#105"),
      v.object({ lifecycle_state: v.string() }),
    )[0];
    expect(lifecycle?.lifecycle_state).toBe("closed");
  });

  it("merged absorbs later reopen observations", () => {
    const r = ref(106);
    pullRequest(r, "opened", "it-opened-106");
    pullRequest(r, "closed", "it-merged-106", {
      lifecycle: { state: "merged", observedAt: "2024-01-01T00:00:00Z" },
    });
    pullRequest(r, "reopened", "it-reopen-106", {
      lifecycle: { state: "open", observedAt: "2024-01-02T00:00:00Z" },
    });
    const lifecycle = readRows(
      db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#106"),
      v.object({ lifecycle_state: v.string() }),
    )[0];
    expect(lifecycle?.lifecycle_state).toBe("merged");
  });

  it("approval mode stores awaiting approval instead of a review on opened", () => {
    const r = ref(107);
    runDelivery(
      db,
      { features: { ...FEATURES, review: "approval" } },
      {
        kind: "pull_request",
        headers: headers("it-opened-107"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    expect(runs("o/r#107", "review")).toHaveLength(0);
    const approval = readRows(
      db.prepare(`SELECT approval_json FROM pr_state WHERE pr_key = ?`).all("o/r#107"),
      v.object({ approval_json: v.nullable(v.string()) }),
    )[0]?.approval_json;
    const doc = v.parse(
      v.object({ state: v.string(), workflowStartAdmits: v.boolean() }),
      JSON.parse(approval ?? "{}"),
    );
    expect(doc.state).toBe("awaiting");
    expect(doc.workflowStartAdmits).toBe(true);
  });

  it("review_approved admits an awaiting review", () => {
    const r = ref(108);
    runDelivery(
      db,
      { features: { ...FEATURES, review: "approval" } },
      {
        kind: "pull_request",
        headers: headers("it-opened-108"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    const result = runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-approve-108"),
        signal: { kind: "pull_request_review", ref: r },
      },
    );
    expect(runs("o/r#108", "review")).toHaveLength(1);
    expect(result.events.some((e) => e.name === "review_approved")).toBe(true);
  });

  it("every_push supersedes an active auto review", () => {
    const r = ref(109);
    const cadence = { ...FEATURES, reviewCadence: "every_push" as const };
    runDelivery(
      db,
      { features: cadence },
      {
        kind: "pull_request",
        headers: headers("it-opened-109"),
        ref: r,
        action: "opened",
      },
    );
    runDelivery(
      db,
      { features: cadence },
      {
        kind: "pull_request",
        headers: headers("it-sync-109"),
        ref: { ...r, headSha: "sha-2" },
        action: "synchronize",
      },
    );
    const review = runs("o/r#109", "review");
    expect(review).toHaveLength(2);
    expect(review.filter((row) => row.status === "superseded")).toHaveLength(1);
    expect(review.filter((row) => row.status === "pending_dispatch")).toHaveLength(1);
  });
});

describe("intake transaction semantics ported from postgres suite", () => {
  beforeEach(() => {
    for (const table of [
      "work_run_attempts",
      "work_runs",
      "pr_state",
      "webhook_deliveries",
      "webhook_rejections",
      "webhook_body_replays",
      "ask_quota_reservations",
      "ask_quota_buckets",
      "ask_quota_execution_receipts",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  function slash(input: Partial<SlashCommandInput>, delivery = `sl-${randomUUID()}`) {
    const full: SlashCommandInput = {
      headers: headers(delivery),
      installationId: 6589001,
      owner: "o",
      repo: "r",
      prNumber: 600,
      commentId: 800,
      commenterId: 658,
      commenterLogin: "alice",
      command: "ask",
      body: "/ask why?",
      replyTarget: { kind: "prConversation", prNumber: 600 },
      ...input,
    };
    return runDelivery(db, { features: FEATURES }, { kind: "slash", input: full });
  }
  const askRuns = () => runs("o/r#600", "ask");
  const ackBodies = () =>
    runs("o/r#600", "ack")
      .map(
        (row) =>
          (JSON.parse(row.payload_json ?? "{}") as { reply?: { body?: string } }).reply?.body,
      )
      .filter((body): body is string => typeof body === "string");

  it("happy path: one delivery commits webhook, work item, ack, and review jobs", () => {
    const result = pullRequest(ref(201), "opened", "it-happy-201");
    expect(result.events.some((e) => e.name === "agent_work_enqueued")).toBe(true);
    expect(runs("o/r#201", "review")).toHaveLength(1);
    expect(runs("o/r#201", "ack").length).toBeGreaterThan(0);
    expect(deliveries().some((row) => row.delivery_key === "delivery:it-happy-201")).toBe(true);
  });

  it.each(["body_replay", "delivery_key", "delivery_key_changed_body"])(
    "records every rejected arrival without creating work or jobs: %s",
    (variant) => {
      const r = ref(202);
      const body = JSON.stringify({ n: "dup-body" });
      runDelivery(
        db,
        { features: FEATURES },
        {
          kind: "pull_request",
          headers: headers("it-dup-202-a", body),
          ref: r,
          action: "opened",
        },
      );
      const second = runDelivery(
        db,
        { features: FEATURES },
        {
          kind: "pull_request",
          headers: headers(
            variant === "body_replay" ? "it-dup-202-b" : "it-dup-202-a",
            variant === "delivery_key_changed_body" ? JSON.stringify({ n: "other" }) : body,
          ),
          ref: r,
          action: "opened",
        },
      );
      expect(second.events.length).toBeGreaterThan(0);
      expect(runs("o/r#202", "review")).toHaveLength(1);
      const rejections = readRows(
        db.prepare(`SELECT metadata_json FROM webhook_rejections`).all(),
        v.object({ metadata_json: v.string() }),
      );
      expect(rejections.length).toBeGreaterThan(0);
    },
  );

  it("rejects failed duplicate evidence and records a subsequent retry", () => {
    const r = ref(203);
    const body = JSON.stringify({ n: "fail-dup" });
    expect(() =>
      immediate(db, () => {
        insertWebhookEvent(db, headers("it-fail-203", body), "accepted");
        throw new Error("injected delivery failure");
      }),
    ).toThrow("injected delivery failure");
    pullRequest(r, "opened", "it-fail-203-retry");
    expect(runs("o/r#203", "review")).toHaveLength(1);
  });

  it.each(["enqueue-first", "ignored-first"])("ignored-action flip: %s", (order) => {
    const r = ref(204);
    if (order === "enqueue-first") {
      pullRequest(r, "opened", "it-flip-204-open");
      runDelivery(
        db,
        { features: FEATURES },
        {
          kind: "ignored",
          headers: headers("it-flip-204-ign"),
          decision: "labeled",
        },
      );
    } else {
      runDelivery(
        db,
        { features: FEATURES },
        {
          kind: "ignored",
          headers: headers("it-flip-204-ign"),
          decision: "labeled",
        },
      );
      pullRequest(r, "opened", "it-flip-204-open");
    }
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "ignored",
        headers: headers("it-flip-204-ign"),
        decision: "labeled",
      },
    );
    expect(runs("o/r#204", "review")).toHaveLength(1);
  });

  it.each(["closed", "merged"])(
    "close %s commits mixed review/triage cancellation and running-primary acknowledgement",
    (state) => {
      const r = ref(205);
      pullRequest(r, "opened", `it-open-205-${state}`);
      slash({ command: "triage", body: "/triage", prNumber: 205 });
      pullRequest(r, "closed", `it-close-205-${state}`, {
        lifecycle: { state, observedAt: "2024-02-01T00:00:00Z" },
      });
      expect(runs("o/r#205", "review").every((row) => row.status === "cancelled")).toBe(true);
      expect(runs("o/r#205", "triage").every((row) => row.status === "cancelled")).toBe(true);
      expect(
        readRows(
          db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#205"),
          v.object({ lifecycle_state: v.string() }),
        )[0]?.lifecycle_state,
      ).toBe(state);
    },
  );

  it.each(["auto", "manual"])("close gates review until a newer reopen: %s mode", (mode) => {
    const r = ref(206);
    const features = { ...FEATURES, review: mode } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers(`it-o206-${mode}`),
        ref: r,
        action: "opened",
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers(`it-c206-${mode}`),
        ref: r,
        action: "closed",
        opts: { lifecycle: { state: "closed", observedAt: "2024-01-02T00:00:00Z" } },
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers(`it-o206b-${mode}`),
        ref: r,
        action: "opened",
      },
    );
    const afterStaleOpen = runs("o/r#206", "review").filter(
      (row) => row.status === "pending_dispatch" || row.status === "running",
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers(`it-r206-${mode}`),
        ref: r,
        action: "reopened",
        opts: { lifecycle: { state: "open", observedAt: "2024-01-03T00:00:00Z" } },
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers(`it-o206c-${mode}`),
        ref: r,
        action: "opened",
      },
    );
    const active = runs("o/r#206", "review").filter(
      (row) => row.status === "pending_dispatch" || row.status === "running",
    );
    expect(afterStaleOpen).toHaveLength(0);
    expect(active).toHaveLength(mode === "auto" ? 1 : 0);
    expect(
      readRows(
        db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#206"),
        v.object({ lifecycle_state: v.string() }),
      )[0]?.lifecycle_state,
    ).toBe("open");
  });

  it("a stale close cannot supersede a newer open observation", () => {
    const r = ref(207);
    pullRequest(r, "opened", "it-o207");
    pullRequest(r, "reopened", "it-r207", {
      lifecycle: { state: "open", observedAt: "2024-03-02T00:00:00Z" },
    });
    pullRequest(r, "closed", "it-c207", {
      lifecycle: { state: "closed", observedAt: "2024-03-01T00:00:00Z" },
    });
    expect(
      readRows(
        db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#207"),
        v.object({ lifecycle_state: v.string() }),
      )[0]?.lifecycle_state,
    ).toBe("open");
    expect(runs("o/r#207", "review")[0]?.status).toBe("pending_dispatch");
  });

  it("equal timestamps resolve merged over closed over open", () => {
    const r = ref(208);
    pullRequest(r, "opened", "it-tie-open");
    pullRequest(r, "closed", "it-tie-closed", {
      lifecycle: { state: "closed", observedAt: "2024-04-01T00:00:00Z" },
    });
    pullRequest(r, "reopened", "it-tie-reopen", {
      lifecycle: { state: "open", observedAt: "2024-04-01T00:00:00Z" },
    });
    expect(
      readRows(
        db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#208"),
        v.object({ lifecycle_state: v.string() }),
      )[0]?.lifecycle_state,
    ).toBe("closed");
    pullRequest(r, "closed", "it-tie-merged", {
      lifecycle: { state: "merged", observedAt: "2024-04-01T00:00:00Z" },
    });
    expect(
      readRows(
        db.prepare(`SELECT lifecycle_state FROM pr_state WHERE pr_key = ?`).all("o/r#208"),
        v.object({ lifecycle_state: v.string() }),
      )[0]?.lifecycle_state,
    ).toBe("merged");
  });

  it("zero-work close refuses delayed automatic review without blocking another repository with the same PR number", () => {
    const a = ref(209);
    pullRequest(a, "closed", "it-c209", {
      lifecycle: { state: "closed", observedAt: "2024-05-01T00:00:00Z" },
    });
    pullRequest(a, "opened", "it-o209-stale", {
      lifecycle: { state: "open", observedAt: "2024-04-01T00:00:00Z" },
    });
    expect(runs("o/r#209", "review").filter((row) => row.status !== "cancelled")).toHaveLength(0);
    const b = { ...ref(210), repo: "other", prNumber: 209 };
    pullRequest(b, "opened", "it-o210");
    expect(runs("o/other#209", "review")).toHaveLength(1);
  });

  it.each(["queued", "completed"])(
    "delayed untrusted open cannot await approval after a %s slash review",
    (status) => {
      slash({ command: "review", body: "/review", prNumber: 211 });
      if (status === "completed") {
        db.prepare(`UPDATE work_runs SET status = 'completed' WHERE kind = 'review'`).run();
      }
      runDelivery(
        db,
        { features: { ...FEATURES, review: "approval" } },
        {
          kind: "pull_request",
          headers: headers(`it-u211-${status}`),
          ref: { ...ref(211), headSha: "sha-x" },
          action: "opened",
          opts: { authorTrust: "awaiting_approval" },
        },
      );
      const approval = readRows(
        db.prepare(`SELECT approval_json FROM pr_state WHERE pr_key = ?`).all("o/r#211"),
        v.object({ approval_json: v.nullable(v.string()) }),
      )[0]?.approval_json;
      expect(approval === null || !approval.includes("awaiting")).toBe(true);
    },
  );

  it("approval mode: untrusted open awaits, workflow start approves once across signals and completion", () => {
    const r = ref(212);
    const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o212"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    expect(runs("o/r#212", "review")).toHaveLength(0);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w212"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: r.headSha,
          prNumbers: [r.prNumber],
        },
      },
    );
    expect(runs("o/r#212", "review")).toHaveLength(1);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-p212"),
        signal: { kind: "pull_request_review", ref: r },
      },
    );
    expect(runs("o/r#212", "review")).toHaveLength(1);
    db.prepare(`UPDATE work_runs SET status = 'completed' WHERE kind = 'review'`).run();
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w212b"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: r.headSha,
          prNumbers: [r.prNumber],
        },
      },
    );
    expect(runs("o/r#212", "review")).toHaveLength(1);
  });

  it("approval mode: a trusted open is never approved again", () => {
    const r = ref(213);
    const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o213"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "trusted" },
      },
    );
    expect(runs("o/r#213", "review")).toHaveLength(1);
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o213b"),
        ref: { ...r, headSha: "sha-b" },
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    expect(runs("o/r#213", "review").length).toBeLessThanOrEqual(2);
  });

  it("approval mode: slash admission consumes awaiting approval", () => {
    const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o214"),
        ref: ref(214),
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    slash({ command: "review", body: "/review", prNumber: 214 });
    expect(runs("o/r#214", "review")).toHaveLength(1);
  });

  it("approval mode: push changes the awaiting head and close/merge withdraws it", () => {
    const r = ref(215);
    const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o215"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-s215"),
        ref: { ...r, headSha: "sha-b" },
        action: "synchronize",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w215-old"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: "sha-a",
          prNumbers: [r.prNumber],
        },
      },
    );
    expect(runs("o/r#215", "review")).toHaveLength(0);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w215-new"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: "sha-b",
          prNumbers: [r.prNumber],
        },
      },
    );
    expect(runs("o/r#215", "review")).toHaveLength(1);
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-c215"),
        ref: r,
        action: "closed",
        opts: { lifecycle: { state: "merged", observedAt: "2024-06-01T00:00:00Z" } },
      },
    );
    expect(runs("o/r#215", "review").every((row) => row.status === "cancelled")).toBe(true);
  });

  it("signed fork contributor waits, and only a maintainer admits the row", () => {
    const r = ref(216);
    const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o216"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_maintainer_approval" },
      },
    );
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w216"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: r.headSha,
          prNumbers: [r.prNumber],
        },
      },
    );
    expect(runs("o/r#216", "review")).toHaveLength(0);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-p216"),
        signal: { kind: "pull_request_review", ref: r },
      },
    );
    expect(runs("o/r#216", "review")).toHaveLength(1);
  });

  it.each(["/review", "/review force"] as const)(
    "signed %s admits a still-awaiting maintainer-only row",
    (body) => {
      const features = { ...FEATURES, review: "approval" } as IntakeFeatures;
      runDelivery(
        db,
        { features },
        {
          kind: "pull_request",
          headers: headers(`it-m217-${body.length}`),
          ref: ref(217),
          action: "opened",
          opts: { authorTrust: "awaiting_maintainer_approval" },
        },
      );
      slash({ command: "review", body, prNumber: 217 });
      expect(runs("o/r#217", "review").some((row) => row.status !== "cancelled")).toBe(true);
    },
  );

  it("every_push reviews a quiet synchronize and once does not", () => {
    const r = ref(218);
    runDelivery(
      db,
      { features: { ...FEATURES, reviewCadence: "every_push" } },
      {
        kind: "pull_request",
        headers: headers("it-ep218"),
        ref: r,
        action: "synchronize",
      },
    );
    expect(runs("o/r#218", "review")).toHaveLength(1);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "pull_request",
        headers: headers("it-once218"),
        ref: ref(219),
        action: "synchronize",
      },
    );
    expect(runs("o/r#219", "review")).toHaveLength(0);
  });

  it("every_push approval waits while an awaiting row exists, then reviews the next push", () => {
    const r = ref(220);
    const features = {
      ...FEATURES,
      review: "approval",
      reviewCadence: "every_push",
    } as IntakeFeatures;
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-o220"),
        ref: r,
        action: "opened",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-s220"),
        ref: { ...r, headSha: "sha-b" },
        action: "synchronize",
        opts: { authorTrust: "awaiting_approval" },
      },
    );
    expect(runs("o/r#220", "review")).toHaveLength(0);
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "review_approved",
        headers: headers("it-w220"),
        signal: {
          kind: "workflow_run",
          installationId: r.installationId,
          owner: r.owner,
          repo: r.repo,
          headSha: "sha-b",
          prNumbers: [r.prNumber],
        },
      },
    );
    runDelivery(
      db,
      { features },
      {
        kind: "pull_request",
        headers: headers("it-s220b"),
        ref: { ...r, headSha: "sha-c" },
        action: "synchronize",
      },
    );
    expect(
      runs("o/r#220", "review").filter((row) => row.status === "pending_dispatch").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("every_push stamps a running slash review and leaves a queued stale-head child alone", () => {
    const r = ref(221);
    const childId = randomUUID();
    insertWorkRun(db, {
      workId: childId,
      prKey: "o/r#221",
      kind: "review",
      payloadJson: JSON.stringify({ source: "slash", headSha: "sha-old" }),
      now: Date.now(),
    });
    insertWorkRun(db, {
      workId: "slash-running-221",
      prKey: "o/r#221",
      kind: "review",
      payloadJson: JSON.stringify({ source: "slash", headSha: "sha-old" }),
      now: Date.now(),
    });
    db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(
      "slash-running-221",
    );
    runDelivery(
      db,
      { features: { ...FEATURES, reviewCadence: "every_push" } },
      {
        kind: "pull_request",
        headers: headers("it-ep221"),
        ref: { ...r, headSha: "sha-new" },
        action: "synchronize",
      },
    );
    const stamped = runs("o/r#221", "review").find((row) => row.work_id === "slash-running-221");
    expect(stamped?.status).toBe("running");
    expect(stamped?.payload_json).toContain("pushFollowUp");
    const child = runs("o/r#221", "review").find((row) => row.work_id === childId);
    expect(child?.status).toBe("pending_dispatch");
  });

  it("every_push replaces an enqueued follow-up with no review job and supersedes other auto work", () => {
    const r = ref(222);
    insertWorkRun(db, {
      workId: "fu-parent-222",
      prKey: "o/r#222",
      kind: "review",
      payloadJson: JSON.stringify({
        source: "slash",
        headSha: "sha-old",
        pushFollowUp: { replacementWorkItemId: "fu-child-222" },
      }),
      now: Date.now(),
    });
    runDelivery(
      db,
      { features: { ...FEATURES, reviewCadence: "every_push" } },
      {
        kind: "pull_request",
        headers: headers("it-ep222"),
        ref: { ...r, headSha: "sha-new" },
        action: "synchronize",
      },
    );
    expect(
      runs("o/r#222", "review").filter(
        (row) => row.status === "pending_dispatch" && row.work_id !== "fu-child-222",
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("every_push keeps a queued follow-up that already has a review job", () => {
    const r = ref(223);
    insertWorkRun(db, {
      workId: "fu-parent-223",
      prKey: "o/r#223",
      kind: "review",
      payloadJson: JSON.stringify({
        source: "slash",
        headSha: "sha-old",
        pushFollowUp: { replacementWorkItemId: "fu-child-223" },
      }),
      now: Date.now(),
    });
    db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run("fu-parent-223");
    insertWorkRun(db, {
      workId: "fu-child-223",
      prKey: "o/r#223",
      kind: "review",
      payloadJson: JSON.stringify({ source: "slash", headSha: "sha-old" }),
      now: Date.now(),
    });
    runDelivery(
      db,
      { features: { ...FEATURES, reviewCadence: "every_push" } },
      {
        kind: "pull_request",
        headers: headers("it-ep223"),
        ref: { ...r, headSha: "sha-new" },
        action: "synchronize",
      },
    );
    const pending = runs("o/r#223", "review").filter((row) => row.status === "pending_dispatch");
    expect(pending.map((row) => row.work_id)).toContain("fu-child-223");
  });

  it("posts one answer for contending ask arrivals", () => {
    slash({ command: "ask", body: "/ask why?", commentId: 800 });
    slash({ command: "ask", body: "/ask why?", commentId: 800 });
    expect(askRuns()).toHaveLength(1);
  });

  it("answers distinct comments in the same inline thread independently", () => {
    const target = { kind: "inlineReviewThread" as const, prNumber: 600, inReplyToCommentId: 650 };
    slash({ command: "ask", body: "/ask why?", commentId: 658, replyTarget: target });
    slash({ command: "ask", body: "/ask why?", commentId: 659, replyTarget: target });
    expect(askRuns()).toHaveLength(2);
  });

  it("treats the same comment id on different reply surfaces as distinct mentions", () => {
    slash({ command: "ask", body: "/ask why?", commentId: 800 });
    slash({
      command: "ask",
      body: "/ask why?",
      commentId: 800,
      replyTarget: { kind: "inlineReviewThread" as const, prNumber: 600, inReplyToCommentId: 500 },
    });
    expect(askRuns()).toHaveLength(2);
  });

  it("does not join mentions across pull requests, repositories, or installations", () => {
    slash({ command: "ask", body: "/ask why?", commentId: 800 });
    slash({ command: "ask", body: "/ask why?", commentId: 800, prNumber: 601 });
    slash({ command: "ask", body: "/ask why?", commentId: 800, repo: "r2" });
    slash({ command: "ask", body: "/ask why?", commentId: 800, installationId: 9999 });
    expect(
      runs("o/r#600", "ask").length +
        runs("o/r#601", "ask").length +
        runs("o/r2#600", "ask").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(["completed", "failed", "cancelled", "superseded"] as const)(
    "joins a retained %s ask instead of answering again",
    (status) => {
      slash({ command: "ask", body: "/ask why?", commentId: 800 });
      db.prepare(`UPDATE work_runs SET status = ? WHERE kind = 'ask'`).run(status);
      slash({ command: "ask", body: "/ask why?", commentId: 800 });
      expect(askRuns()).toHaveLength(1);
      expect(askRuns()[0]?.status).toBe(status);
    },
  );

  it("joins a retained mention without quota admission while a fresh mention throttles", () => {
    const slashWithQuota = (input: Partial<SlashCommandInput>) =>
      runDelivery(
        db,
        { features: FEATURES, ask: { actorMaxOutstanding: 2 } },
        {
          kind: "slash",
          input: {
            headers: headers(`q-${randomUUID()}`),
            command: "ask" as const,
            installationId: 6589001,
            owner: "o",
            repo: "r",
            prNumber: 600,
            replyTarget: { kind: "prConversation", prNumber: 600 },
            ...input,
          } as SlashCommandInput,
        },
      );
    slashWithQuota({ command: "ask", body: "/ask why?", commentId: 900 });
    slashWithQuota({ command: "ask", body: "/ask why?", commentId: 901 });
    slashWithQuota({ command: "ask", body: "/ask why?", commentId: 902 });
    slashWithQuota({ command: "ask", body: "/ask why?", commentId: 900 });
    expect(askRuns()).toHaveLength(2);
    expect(ackBodies()).toContain(ASK_THROTTLED_BODY);
  });

  it("joins a running ask instead of publishing a second answer", () => {
    slash({ command: "ask", body: "/ask why?", commentId: 975 });
    db.prepare(`UPDATE work_runs SET status = 'running' WHERE kind = 'ask'`).run();
    slash({ command: "ask", body: "/ask why?", commentId: 975 });
    expect(askRuns()).toHaveLength(1);
    expect(askRuns()[0]?.status).toBe("running");
  });

  it.each([
    ["/cc looks good", "cc", "Unknown command `/cc`"],
    ["/review-security", "review-security", "Unknown command `/review-security`"],
    ["/cancel", "cancel", "No review is queued or in progress"],
    ["/triage nonsense", "triage", undefined],
  ] as const)("slash %s replies appropriately", (body, command, expected) => {
    slash({ command, body });
    const acks = ackBodies();
    expect(acks.length).toBeGreaterThan(0);
    if (expected !== undefined) expect(acks.some((b) => b.includes(expected))).toBe(true);
  });

  it("keeps the complete durable help response", () => {
    slash({ command: "help", body: "/help" });
    const ack = ackBodies()[0];
    expect(ack).toContain("/review");
    expect(ack).toContain("/ask");
    expect(ack).toContain("/help");
  });

  it("tells every_push operators that a later push starts a review", () => {
    runDelivery(
      db,
      { features: { ...FEATURES, reviewCadence: "every_push" } },
      {
        kind: "slash",
        input: {
          headers: headers("it-help-ep"),
          installationId: 6589001,
          owner: "o",
          repo: "r",
          prNumber: 600,
          commentId: 55,
          commenterId: 1,
          commenterLogin: "alice",
          command: "help",
          body: "/help",
          replyTarget: { kind: "prConversation" as const, prNumber: 600 },
        },
      },
    );
    const ack = ackBodies()[0];
    expect(ack?.includes("push") || ack?.includes("synchronize")).toBe(true);
  });

  it.each(["/triage", "/triage preview", "/triage all exclude 55 66"])(
    "persists triage mode, scope, exclusions and matching queue: %s",
    (body) => {
      slash({ command: "triage", body, prNumber: 230 });
      const triage = runs("o/r#230", "triage");
      expect(triage.length).toBeGreaterThan(0);
      expect(triage[triage.length - 1]?.status).toBe("pending_dispatch");
    },
  );

  it("keeps one deferred verification item for a reply, a duplicate, and an active run", () => {
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "verification_reply",
        headers: headers("it-vr231"),
        installationId: 1,
        owner: "o",
        repo: "r",
        prNumber: 231,
      },
    );
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "verification_reply",
        headers: headers("it-vr231"),
        installationId: 1,
        owner: "o",
        repo: "r",
        prNumber: 231,
      },
    );
    runDelivery(
      db,
      { features: FEATURES },
      {
        kind: "verification_reply",
        headers: headers("it-vr231b"),
        installationId: 1,
        owner: "o",
        repo: "r",
        prNumber: 231,
      },
    );
    expect(runs("o/r#231", "verification")).toHaveLength(1);
    const claim = immediate(db, () =>
      claimDispatchableWorkRun(db, Date.now(), { kinds: ["verification"] }),
    );
    expect(claim?.run.pr_key).toBe("o/r#231");
  });

  it("a throw inside immediate rolls back dedupe + work_runs + pr_state", () => {
    expect(() =>
      immediate(db, () => {
        insertWebhookEvent(db, headers("it-rb-500", JSON.stringify({ n: "rb" })), "accepted");
        insertWorkRun(db, {
          workId: "rb-run-500",
          prKey: "o/r#500",
          kind: "review",
          payloadJson: JSON.stringify({ source: "auto" }),
          now: Date.now(),
        });
        throw new Error("injected delivery failure");
      }),
    ).toThrow("injected delivery failure");
    expect(runs("o/r#500")).toHaveLength(0);
    expect(deliveries().some((row) => row.delivery_key === "delivery:it-rb-500")).toBe(false);
    expect(
      readRows(
        db.prepare(`SELECT pr_key FROM pr_state WHERE pr_key = ?`).all("o/r#500"),
        v.object({ pr_key: v.string() }),
      ),
    ).toHaveLength(0);
  });

  it.each(["auto-first", "force-first"] as const)(
    "serializes real automatic review and forced slash intake: %s",
    (order) => {
      const r = ref(232);
      if (order === "auto-first") {
        pullRequest(r, "opened", `it-${order}-open`);
        slash({ command: "review", body: "/review force", prNumber: 232 });
      } else {
        slash({ command: "review", body: "/review force", prNumber: 232 });
        pullRequest(r, "opened", `it-${order}-open`);
      }
      const reviews = runs("o/r#232", "review").filter(
        (row) => row.status !== "cancelled" && row.status !== "superseded",
      );
      expect(reviews.length).toBeGreaterThanOrEqual(1);
    },
  );

  it("failed prior job: next auto delivery enqueues a fresh runnable job", () => {
    const r = ref(233);
    pullRequest(r, "opened", "it-f233");
    db.prepare(`UPDATE work_runs SET status = 'failed'`).run();
    db.prepare(
      `UPDATE pr_state SET active_review_work_id = NULL, active_review_source = NULL`,
    ).run();
    pullRequest({ ...r, headSha: "sha-b" }, "opened", "it-f233b");
    const pending = runs("o/r#233", "review").filter((row) => row.status === "pending_dispatch");
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });
});

function freshSqliteDir() {
  return mkdtempSync(join(tmpdir(), "pr-agent-single-process-it-"));
}

function pragmaSynchronous(raw: unknown) {
  return v.parse(v.object({ synchronous: v.number() }), raw).synchronous;
}

function postSignedWebhook(port: number, secret: string, delivery: string) {
  const body = Buffer.from(JSON.stringify({ zen: delivery, installation: { id: 1 } }));
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/webhooks",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`,
          "x-github-event": "ping",
          "x-github-delivery": delivery,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("single-process durability (sqlite + pi durable)", () => {
  it("rejects an unsigned or invalid signature before writing any intake state", async () => {
    const state = openSqliteAppState();
    const cfg = makeTestConfig();
    const server = http.createServer();
    const listening = new Promise<number>((resolve, reject) => {
      server.once("listening", () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no webhook port"));
      });
    });
    const layer = buildEffectWebhookLayer(
      cfg,
      () => server,
      Layer.succeed(
        WebhookIntake,
        makeSqliteWebhookIntake({
          db: state.db,
          cfg,
          accepting: () => true,
          ready: () => true,
          afterCommit: () => {},
        }),
      ),
    );
    const fiber = Effect.runFork(Layer.launch(layer));
    try {
      const url = `http://127.0.0.1:${String(await listening)}/webhooks`;
      const body = JSON.stringify({
        action: "opened",
        installation: { id: 1 },
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 1, head: { sha: "a".repeat(40) } },
      });
      const headers = {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "signature-intake",
      };
      for (const signature of [null, `sha256=${"0".repeat(64)}`]) {
        const response = await fetch(url, {
          method: "POST",
          body,
          headers: signature === null ? headers : { ...headers, "x-hub-signature-256": signature },
        });
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("invalid signature");
        for (const table of [
          "webhook_deliveries",
          "webhook_body_replays",
          "webhook_rejections",
          "work_runs",
        ]) {
          expect(state.db.prepare(`SELECT 1 FROM ${table}`).all()).toHaveLength(0);
        }
      }
      const digest = crypto.createHmac("sha256", cfg.webhook.secret).update(body).digest("hex");
      const accepted = await fetch(url, {
        method: "POST",
        body,
        headers: { ...headers, "x-hub-signature-256": `sha256=${digest}` },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe("ok");
      expect(state.db.prepare("SELECT 1 FROM webhook_deliveries").all()).toHaveLength(1);
      expect(state.db.prepare("SELECT 1 FROM webhook_body_replays").all()).toHaveLength(1);
      expect(state.db.prepare("SELECT 1 FROM work_runs WHERE kind = 'review'").all()).toHaveLength(
        1,
      );
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      state.close();
    }
  });

  it("fails a second writer fast while the single-writer lock is held", () => {
    const dir = freshSqliteDir();
    expect(() =>
      openAppState({
        sqliteDir: dir,
        dbPath: join(dir, "..", "outside.sqlite"),
        applySchema: applyAppStateSchema,
      }),
    ).toThrow(/directly inside SQLITE_DIR/);
    expect(() =>
      openAppState({
        sqliteDir: dir,
        dbPath: join(dir, "pi_durable.sqlite"),
        applySchema: applyAppStateSchema,
      }),
    ).toThrow(/runtime database/);
    const first = openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema });
    try {
      const started = Date.now();
      expect(() => openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema })).toThrow(
        /holds the SQLite writer lock/,
      );
      expect(() => acquireSingleWriterLock(dir)).toThrow(/holds the SQLite writer lock/);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      first.close();
    }
    const reopened = openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema });
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("releases the lock when the holding process is SIGKILLed", async () => {
    const dir = freshSqliteDir();
    const dbModule = join(process.cwd(), "src", "state", "db.ts");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireSingleWriterLock } from ${JSON.stringify(dbModule)};
         acquireSingleWriterLock(${JSON.stringify(dir)});
         process.stdout.write("locked\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("locked")) resolve();
        });
        child.once("exit", (code) =>
          reject(new Error(`lock holder exited early: ${String(code)}`)),
        );
      });
      expect(() => acquireSingleWriterLock(dir)).toThrow(/holds the SQLite writer lock/);
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("exit", (_code, signal) => resolve(signal)),
      );
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      const lock = acquireSingleWriterLock(dir);
      lock.db.exec("ROLLBACK");
      lock.db.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads back PRAGMA synchronous = FULL (2) on app_state and pi_durable", async () => {
    const dir = freshSqliteDir();
    const appState = openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema });
    const runtime = await openDurableRuntime(makeTestConfig({ runtime: { sqliteDir: dir } }));
    try {
      expect(pragmaSynchronous(appState.db.prepare("PRAGMA synchronous").get())).toBe(2);
      expect(runtime.handle.synchronous).toBe(2);
    } finally {
      await runtime.handle.harness.close(BACKGROUND_CONTEXT);
      appState.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves pi_durable.sqlite, -wal, and -shm together into one archive directory", async () => {
    const dir = freshSqliteDir();
    for (const name of ["pi_durable.sqlite", "pi_durable.sqlite-wal", "pi_durable.sqlite-shm"]) {
      writeFileSync(join(dir, name), name);
    }
    const { archiveDir, archived } = await archivePiDurableFiles(
      dir,
      Date.parse("2026-01-02T03:04:05.678Z"),
    );
    expect(archiveDir).toBe(join(dir, "archive", "2026-01-02T03-04-05-678Z"));
    expect(archived).toEqual([
      "pi_durable.sqlite",
      "pi_durable.sqlite-wal",
      "pi_durable.sqlite-shm",
    ]);
    expect(readdirSync(archiveDir).toSorted()).toEqual([
      "pi_durable.sqlite",
      "pi_durable.sqlite-shm",
      "pi_durable.sqlite-wal",
    ]);
    expect(readdirSync(dir).filter((name) => name.startsWith("pi_durable"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resets pi_durable.sqlite with zero 503s on /webhooks and a fresh harness afterwards", async () => {
    initEvlog("error", { silent: true, suppressDrainWarning: true });
    const dir = freshSqliteDir();
    const cfg = makeTestConfig({
      runtime: {
        sqliteDir: dir,
        sqliteDbPath: null,
        shutdownGraceMs: 2_000,
        piDurableResetMaxBytes: 2_147_483_648,
        piDurableResetMaxAgeSeconds: 2_592_000,
      },
      retention: { enabled: false },
      webhook: { secret: "reset-secret" },
    });
    const appState = openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema });
    const runtime = await openDurableRuntime(cfg);
    const original = await runtime.handle.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const service = await startDurableService({
      appState,
      cfg,
      runtime,
      reopenRuntime: () => openDurableRuntime(cfg),
      installationSurface: openInstallationSurface(),
      createHandlers: (deps) => ({
        review: createReviewRunner(deps),
        feature: () => async () => {},
        ack: async () => {},
      }),
    });
    let server: http.Server | undefined;
    let fiber: Fiber.Fiber<never, unknown> | undefined;
    const listening = new Promise<number>((resolve) => {
      const layer = buildEffectWebhookLayer(
        { ...cfg, runtime: { ...cfg.runtime, port: 0 } },
        () => {
          server = http.createServer();
          server.once("listening", () => {
            const address = server?.address();
            resolve(typeof address === "object" && address !== null ? address.port : 0);
          });
          return server;
        },
        Layer.succeed(
          WebhookIntake,
          makeSqliteWebhookIntake({
            db: appState.db,
            cfg,
            accepting: service.acceptingWebhooks,
            ready: service.ready,
            afterCommit: service.afterIntakeCommit,
          }),
        ),
      );
      fiber = Effect.runFork(Layer.launch(layer));
    });
    try {
      const port = await listening;
      const statuses: number[] = [];
      const resetDone = { value: false };
      const traffic = (async () => {
        let n = 0;
        while (!resetDone.value) {
          n += 1;
          statuses.push(await postSignedWebhook(port, "reset-secret", `reset-${String(n)}`));
        }
        statuses.push(await postSignedWebhook(port, "reset-secret", "reset-after"));
      })();
      const outcome = await service.checkReset("size");
      resetDone.value = true;
      await traffic;
      expect(outcome.kind).toBe("reset");
      if (outcome.kind !== "reset") throw new Error("reset did not run");
      expect(statuses.length).toBeGreaterThan(1);
      expect(statuses.every((status) => status === 200)).toBe(true);
      expect(readdirSync(outcome.archiveDir)).toContain("pi_durable.sqlite");
      expect(outcome.archived).toContain("pi_durable.sqlite");
      expect(existsSync(join(dir, "pi_durable.sqlite"))).toBe(true);
      expect(service.deps.runtime).toBe(outcome.runtime);
      expect(service.ready()).toBe(true);
      const fresh = await service.deps.runtime.handle.harness.inspect(BACKGROUND_CONTEXT);
      expect(fresh.scheduling).toBe("running");
      expect(
        await service.deps.runtime.handle.harness.conversation(original.id, BACKGROUND_CONTEXT),
      ).toBeUndefined();
      expect(
        readRows(
          appState.db.prepare(`SELECT delivery_key FROM webhook_deliveries`).all(),
          v.object({ delivery_key: v.string() }),
        ),
      ).toHaveLength(statuses.length);
    } finally {
      await service.shutdown("test");
      if (fiber !== undefined) await Effect.runPromise(Fiber.interrupt(fiber));
      if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
