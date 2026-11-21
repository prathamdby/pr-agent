import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import {
  awaitAttemptAdmission,
  FeatureAttemptTask,
  startAttemptTask,
  startFeatureAttempt,
  type AttemptStamp,
} from "../../src/agent/runtime/durable/featureAttemptTask.ts";
import {
  openDurableRuntime,
  type DurableRuntime,
} from "../../src/agent/runtime/durable/runtime.ts";
import {
  runBootPhaseA,
  startDurableService,
  type DurableService,
} from "../../src/agent/runtime/durable/boot.ts";
import type { DispatcherHandlers } from "../../src/agent/runtime/durable/dispatcher.ts";
import type { WorkerDeps } from "../../src/agent/runtime/durable/workerDeps.ts";
import { openAppState, type AppStateHandle } from "../../src/state/db.ts";
import { applyAppStateSchema } from "../../src/state/schema.ts";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.ts";
import { makeTestConfig } from "../helpers/config.ts";
import {
  bumpLaneEpoch,
  cancelWorkRun,
  claimDispatchableWorkRun,
  insertWorkRun,
  markAttemptRunning,
  markWorkRunCompleted,
  markWorkRunFailed,
  attemptFor,
  supersedeWorkRun,
  workRunById,
} from "../../src/state/workRuns.ts";
import { immediate, readRow, readRows } from "../../src/state/db.ts";
import { resolveAskQuotaConfig, reserveAskQuota } from "../../src/state/askQuotas.ts";
import { ensurePrState } from "../../src/state/intake.ts";
import { openSqliteAppState } from "./db.ts";

const state = openSqliteAppState();
const db = state.db;

afterAll(() => {
  state.close();
});

afterEach(() => {
  db.prepare(`DELETE FROM work_run_attempts`).run();
  db.prepare(`DELETE FROM work_runs`).run();
  db.prepare(`DELETE FROM pr_state`).run();
});

function insertRun(
  workId: string,
  prKey: string,
  kind: "review" | "ack" | "ask" | "description" | "triage" | "verification",
  laneEpoch = 0,
) {
  insertWorkRun(db, {
    workId,
    prKey,
    kind,
    laneEpoch,
    payloadJson: JSON.stringify({ source: "auto", headSha: "sha-1" }),
    now: Date.now(),
  });
}

function quotaReservationRow(workId: string) {
  return readRow(
    db.prepare(`SELECT released_at FROM ask_quota_reservations WHERE work_item_id = ?`).get(workId),
    v.object({ released_at: v.nullable(v.number()) }),
  );
}

describe("stale queued work fencing (sqlite)", () => {
  it("claims a pending_dispatch run and creates an attempt", () => {
    insertRun("stale-claim-1", "o/r#1", "ack");
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).toBe("stale-claim-1");
    expect(claimed?.attempt.attempt_no).toBe(1);
    expect(claimed?.run.current_attempt_no).toBe(1);
    immediate(db, () =>
      markAttemptRunning(db, {
        workId: "stale-claim-1",
        attemptNo: 1,
        conversationId: "conv-1",
        taskId: null,
        now: Date.now(),
      }),
    );
    expect(workRunById(db, "stale-claim-1")?.status).toBe("running");
  });

  it("fences a run whose lane epoch is stale", () => {
    ensurePrState(db, "o/r#2", Date.now());
    insertRun("stale-fence-2", "o/r#2", "review", 0);
    bumpLaneEpoch(db, { prKey: "o/r#2", lane: "review", now: Date.now() });
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).not.toBe("stale-fence-2");
    const stale = readRows(
      db.prepare(`SELECT work_id, status FROM work_runs WHERE work_id = ?`).all("stale-fence-2"),
      v.object({ work_id: v.string(), status: v.string() }),
    )[0];
    expect(claimed).toBeUndefined();
    expect(stale?.status).toBe("pending_dispatch");
  });

  it("claims the run carrying the current lane epoch", () => {
    ensurePrState(db, "o/r#3", Date.now());
    insertRun("stale-old-3", "o/r#3", "review", 0);
    bumpLaneEpoch(db, { prKey: "o/r#3", lane: "review", now: Date.now() });
    insertRun("stale-new-3", "o/r#3", "review", 1);
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).toBe("stale-new-3");
  });

  it("does not claim runs scheduled for a future retry", () => {
    insertRun("stale-retry-4", "o/r#4", "ack");
    db.prepare(
      `UPDATE work_runs SET status = 'retry_scheduled', next_retry_at = ? WHERE work_id = ?`,
    ).run(Date.now() + 60_000, "stale-retry-4");
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).not.toBe("stale-retry-4");
  });

  it("claims a due retry_scheduled run", () => {
    insertRun("stale-retry-5", "o/r#5", "ack");
    db.prepare(
      `UPDATE work_runs SET status = 'retry_scheduled', next_retry_at = ? WHERE work_id = ?`,
    ).run(Date.now() - 1_000, "stale-retry-5");
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).toBe("stale-retry-5");
    expect(claimed?.attempt.attempt_no).toBe(1);
  });

  it("flags a queued review with no live lease and no pg-boss job", () => {
    insertRun("stale-aged-6", "o/r#6", "ack");
    db.prepare(`UPDATE work_runs SET created_at = 1, updated_at = 1 WHERE work_id = ?`).run(
      "stale-aged-6",
    );
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).toBe("stale-aged-6");
  });

  it("leaves lost-running a no-op on a queued ask and fails it through stale-queued reconciliation", () => {
    insertRun("stale-ask-7", "o/r#7", "ask");
    reserveAskQuota(
      db,
      {
        workItemId: "stale-ask-7",
        installationId: 6589001,
        owner: "o",
        repo: "r",
        commenterId: 658,
      },
      resolveAskQuotaConfig({}),
    );
    expect(quotaReservationRow("stale-ask-7")?.released_at).toBeNull();
    immediate(db, () =>
      cancelWorkRun(db, { workId: "stale-ask-7", reason: "stale_queue", now: Date.now() }),
    );
    expect(workRunById(db, "stale-ask-7")?.status).toBe("cancelled");
    expect(quotaReservationRow("stale-ask-7")?.released_at).not.toBeNull();
    expect(immediate(db, () => claimDispatchableWorkRun(db, Date.now()))).toBeUndefined();
  });

  it.each(["review", "description", "triage", "verification"] as const)(
    "fails a truly stale queued %s item",
    (kind) => {
      ensurePrState(db, `o/r#${kind}`, Date.now());
      insertRun(`stale-aged-${kind}`, `o/r#${kind}`, kind);
      db.prepare(`UPDATE work_runs SET created_at = 1, updated_at = 1 WHERE work_id = ?`).run(
        `stale-aged-${kind}`,
      );
      const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
      expect(claimed?.run.work_id).toBe(`stale-aged-${kind}`);
    },
  );

  it.each(["cancelled", "superseded"] as const)(
    "finishes a cancel-requested queued review as %s",
    (status) => {
      ensurePrState(db, `o/r#cancel-${status}`, Date.now());
      insertRun(`stale-cancel-${status}`, `o/r#cancel-${status}`, "review");
      if (status === "superseded") {
        insertRun("stale-cancel-successor", "o/r#cancel-superseded", "review");
        immediate(db, () =>
          supersedeWorkRun(db, { workId: "stale-cancel-superseded", now: Date.now() }),
        );
      } else {
        immediate(db, () =>
          cancelWorkRun(db, {
            workId: "stale-cancel-cancelled",
            reason: "cancel_requested",
            now: Date.now(),
          }),
        );
      }
      const row = workRunById(db, `stale-cancel-${status}`);
      expect(row?.status).toBe(status);
      expect(row?.cancel_reason).toBe(status === "cancelled" ? "cancel_requested" : null);
      const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
      expect(claimed?.run.work_id).not.toBe(`stale-cancel-${status}`);
    },
  );

  it.each(["completed", "failed", "cancelled", "superseded"] as const)(
    "does not close or overwrite a candidate changed to %s after detection",
    (status) => {
      const workId = `stale-terminal-${status}`;
      ensurePrState(db, `o/r#terminal-${status}`, Date.now());
      insertRun(workId, `o/r#terminal-${status}`, "review");
      if (status === "cancelled") {
        immediate(db, () =>
          cancelWorkRun(db, { workId, reason: "cancel_requested", now: Date.now() }),
        );
      } else if (status === "superseded") {
        immediate(db, () => supersedeWorkRun(db, { workId, now: Date.now() }));
      } else {
        const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
        markAttemptRunning(db, {
          workId,
          attemptNo: claimed!.attempt.attempt_no,
          conversationId: `conv-${status}`,
          taskId: null,
          now: Date.now(),
        });
        if (status === "completed") {
          markWorkRunCompleted(db, { workId, attemptNo: 1, now: Date.now() });
        } else {
          markWorkRunFailed(db, {
            workId,
            attemptNo: 1,
            errorJson: JSON.stringify({ message: "boom" }),
            now: Date.now(),
          });
        }
      }
      expect(workRunById(db, workId)?.status).toBe(status);
      expect(immediate(db, () => claimDispatchableWorkRun(db, Date.now()))).toBeUndefined();
    },
  );

  it("does not fail a queued ask inside the grace window", () => {
    insertRun("stale-ask-grace", "o/r#ask-grace", "ask");
    reserveAskQuota(
      db,
      {
        workItemId: "stale-ask-grace",
        installationId: 6589001,
        owner: "o",
        repo: "r",
        commenterId: 658,
      },
      resolveAskQuotaConfig({}),
    );
    db.prepare(`UPDATE work_runs SET created_at = 1, updated_at = 1 WHERE work_id = ?`).run(
      "stale-ask-grace",
    );
    expect(workRunById(db, "stale-ask-grace")?.status).toBe("pending_dispatch");
    expect(quotaReservationRow("stale-ask-grace")?.released_at).toBeNull();
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    expect(claimed?.run.work_id).toBe("stale-ask-grace");
  });

  it("does not flag a queued review that still has a deferred watchdog hop", () => {
    insertRun("stale-deferred-8", "o/r#8", "ack");
    db.prepare(
      `UPDATE work_runs SET status = 'retry_scheduled', next_retry_at = ? WHERE work_id = ?`,
    ).run(Date.now() + 3600_000, "stale-deferred-8");
    expect(immediate(db, () => claimDispatchableWorkRun(db, Date.now()))).toBeUndefined();
  });

  it("preserves running work during cancellation after routing", () => {
    ensurePrState(db, "o/r#9", Date.now());
    insertRun("stale-running-9", "o/r#9", "review");
    const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
    markAttemptRunning(db, {
      workId: "stale-running-9",
      attemptNo: claimed!.attempt.attempt_no,
      conversationId: "conv-running-9",
      taskId: null,
      now: Date.now(),
    });
    expect(immediate(db, () => claimDispatchableWorkRun(db, Date.now()))).toBeUndefined();
    expect(workRunById(db, "stale-running-9")?.status).toBe("running");
  });
});

let reviewTaskDb: AppStateHandle["db"] | undefined;

const TestReviewTask = defineTask<AttemptStamp, { readonly phase: "run" }, null>({
  name: "test.review_attempt",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, ctx) => {
      const db = reviewTaskDb;
      if (db !== undefined && (await awaitAttemptAdmission(db, task.input))) {
        immediate(db, () =>
          markWorkRunCompleted(db, {
            workId: task.input.workId,
            attemptNo: task.input.attemptNo,
            now: Date.now(),
          }),
        );
      }
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: null },
        }),
        ctx,
      );
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "terminal" as const, outcome: { status: "aborted" as const } }),
      ctx,
    );
  },
});

const TASKS = [FeatureAttemptTask, TestReviewTask];

type BootScenario = {
  readonly dir: string;
  readonly cfg: ReturnType<typeof makeTestConfig>;
  readonly appState: AppStateHandle;
  readonly calls: { feature: string[]; review: string[]; ack: string[] };
};

const scenarios: BootScenario[] = [];
const services: DurableService[] = [];

function bootScenario(queue: { readonly retryLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-agent-boot-it-"));
  const cfg = makeTestConfig({
    runtime: {
      sqliteDir: dir,
      sqliteDbPath: null,
      shutdownGraceMs: 2_000,
      piDurableResetMaxBytes: 2_147_483_648,
      piDurableResetMaxAgeSeconds: 2_592_000,
    },
    queue: { retryDelaySeconds: 0, retryDelayMaxSeconds: 1, ...queue },
    retention: { enabled: false },
  });
  const appState = openAppState({ sqliteDir: dir, applySchema: applyAppStateSchema });
  reviewTaskDb = appState.db;
  const scenario = { dir, cfg, appState, calls: { feature: [], review: [], ack: [] } };
  scenarios.push(scenario);
  return scenario;
}

function scenarioHandlers(scenario: BootScenario, deps: WorkerDeps) {
  return ((pinnedReturn: DispatcherHandlers) => pinnedReturn)({
    review: async (claim) => {
      scenario.calls.review.push(claim.run.work_id);
      const runtime = deps.runtime;
      const started = await startAttemptTask({
        harness: runtime.handle.harness,
        context: BACKGROUND_CONTEXT,
        db: scenario.appState.db,
        claim,
        task: TestReviewTask,
        input: {
          workId: claim.run.work_id,
          attemptNo: claim.attempt.attempt_no,
          attemptId: claim.attempt.attempt_id,
        },
      });
      if (started.markedRunning)
        await runtime.handle.harness.waitForTask(started.taskId, BACKGROUND_CONTEXT);
    },
    feature: () => async (ctx) => {
      scenario.calls.feature.push(`${ctx.run.work_id}#${String(ctx.attempt.attempt_no)}`);
    },
    ack: async (claim) => {
      scenario.calls.ack.push(claim.run.work_id);
    },
  });
}

async function startService(scenario: BootScenario, runtime: DurableRuntime) {
  const service = await startDurableService({
    appState: scenario.appState,
    cfg: scenario.cfg,
    runtime,
    reopenRuntime: () => openDurableRuntime(scenario.cfg, { tasks: TASKS }),
    installationSurface: openInstallationSurface(),
    reviewTaskName: TestReviewTask.definition.name,
    createHandlers: (deps) => scenarioHandlers(scenario, deps),
    intervals: { dispatcherIdleWakeMs: 20 },
  });
  services.push(service);
  return service;
}

async function crash(runtime: DurableRuntime) {
  await runtime.handle.harness.close(BACKGROUND_CONTEXT);
}

async function eventually(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function claimRun(scenario: BootScenario, workId: string) {
  const db = scenario.appState.db;
  const claimed = immediate(db, () => claimDispatchableWorkRun(db, Date.now()));
  expect(claimed?.run.work_id).toBe(workId);
  if (claimed === undefined) throw new Error("no claim");
  return claimed;
}

function seedRun(
  scenario: BootScenario,
  workId: string,
  kind: "review" | "ask" | "description",
  prKey = `o/r#${workId}`,
) {
  const db = scenario.appState.db;
  ensurePrState(db, prKey, Date.now());
  insertWorkRun(db, {
    workId,
    prKey,
    kind,
    payloadJson: JSON.stringify({ owner: "o", repo: "r", prNumber: 1, installationId: 1 }),
    now: Date.now(),
  });
}

describe("boot barrier and dispatcher (sqlite + pi durable)", () => {
  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown("test");
    for (const scenario of scenarios.splice(0)) {
      scenario.appState.close();
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("retries an interrupted feature attempt as attempt_no + 1 and aborts the old task", async () => {
    const scenario = bootScenario();
    seedRun(scenario, "boot-feature-1", "description");
    const first = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const claim = claimRun(scenario, "boot-feature-1");
    const started = await startFeatureAttempt({
      harness: first.handle.harness,
      context: BACKGROUND_CONTEXT,
      db: scenario.appState.db,
      claim,
    });
    expect(started.markedRunning).toBe(true);
    await crash(first);

    const second = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const service = await startService(scenario, second);
    expect(service.phaseA.schedulingDuringPhaseA).toEqual(["paused", "paused"]);
    expect(service.phaseA.interrupted).toBe(1);
    expect(service.phaseA.toAbort).toEqual([started.taskId]);
    expect(attemptFor(scenario.appState.db, "boot-feature-1", 1)?.status).toBe("failed");
    expect(attemptFor(scenario.appState.db, "boot-feature-1", 1)?.error_json).toContain(
      '"interrupted":true',
    );
    await eventually(
      () => workRunById(scenario.appState.db, "boot-feature-1")?.status === "completed",
    );
    expect(workRunById(scenario.appState.db, "boot-feature-1")?.current_attempt_no).toBe(2);
    expect(scenario.calls.feature).toEqual(["boot-feature-1#2"]);
    const old = await second.handle.harness.waitForTask(started.taskId, BACKGROUND_CONTEXT);
    expect(old.state.outcome.status).toBe("aborted");
  });

  it("skips a stale-lane claim and dispatches only the current lane epoch", async () => {
    const scenario = bootScenario();
    const db = scenario.appState.db;
    seedRun(scenario, "boot-lane-old", "review", "o/r#lane");
    bumpLaneEpoch(db, { prKey: "o/r#lane", lane: "review", now: Date.now() });
    insertWorkRun(db, {
      workId: "boot-lane-new",
      prKey: "o/r#lane",
      kind: "review",
      laneEpoch: 1,
      payloadJson: "{}",
      now: Date.now(),
    });
    await startService(scenario, await openDurableRuntime(scenario.cfg, { tasks: TASKS }));
    await eventually(() => workRunById(db, "boot-lane-new")?.status === "completed");
    expect(scenario.calls.review).toEqual(["boot-lane-new"]);
    expect(workRunById(db, "boot-lane-old")?.status).toBe("pending_dispatch");
    expect(workRunById(db, "boot-lane-old")?.current_attempt_no).toBe(0);
  });

  it("aborts a superseded orphan only after resume()", async () => {
    const scenario = bootScenario();
    const db = scenario.appState.db;
    seedRun(scenario, "boot-orphan-superseded", "review");
    const first = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const claim = claimRun(scenario, "boot-orphan-superseded");
    const orphan = await first.handle.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      return tx.createTask(
        TestReviewTask,
        {
          workId: claim.run.work_id,
          attemptNo: claim.attempt.attempt_no,
          attemptId: claim.attempt.attempt_id,
        },
        { ownership: { kind: "conversation" }, conversationId: conversation.id },
      );
    }, BACKGROUND_CONTEXT);
    await crash(first);
    immediate(db, () =>
      supersedeWorkRun(db, { workId: "boot-orphan-superseded", now: Date.now() }),
    );

    const second = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const phaseA = await runBootPhaseA({
      db,
      cfg: scenario.cfg,
      runtime: second,
      reviewTaskName: TestReviewTask.definition.name,
    });
    expect(phaseA.toAbort).toEqual([orphan]);
    expect((await second.handle.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
    expect(
      (await second.handle.harness.getTask(orphan, BACKGROUND_CONTEXT))?.state.status,
    ).not.toBe("terminal");
    await crash(second);

    const third = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const service = await startService(scenario, third);
    expect(service.phaseA.toAbort).toEqual([orphan]);
    const settled = await third.handle.harness.waitForTask(orphan, BACKGROUND_CONTEXT);
    expect(settled.state.outcome.status).toBe("aborted");
    expect(workRunById(db, "boot-orphan-superseded")?.status).toBe("superseded");
    expect(scenario.calls.review).toEqual([]);
  });

  it("releases the ask quota when an interrupted attempt exhausts its budget", async () => {
    const scenario = bootScenario({ retryLimit: 0 });
    const db = scenario.appState.db;
    seedRun(scenario, "boot-ask-quota", "ask");
    reserveAskQuota(
      db,
      {
        workItemId: "boot-ask-quota",
        installationId: 6589002,
        owner: "o",
        repo: "r",
        commenterId: 659,
      },
      resolveAskQuotaConfig({}),
    );
    const first = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    await startFeatureAttempt({
      harness: first.handle.harness,
      context: BACKGROUND_CONTEXT,
      db,
      claim: claimRun(scenario, "boot-ask-quota"),
    });
    await crash(first);
    const service = await startService(
      scenario,
      await openDurableRuntime(scenario.cfg, { tasks: TASKS }),
    );
    expect(service.phaseA.interrupted).toBe(1);
    expect(workRunById(db, "boot-ask-quota")?.status).toBe("failed");
    expect(
      readRow(
        db
          .prepare(`SELECT released_at FROM ask_quota_reservations WHERE work_item_id = ?`)
          .get("boot-ask-quota"),
        v.object({ released_at: v.nullable(v.number()) }),
      )?.released_at,
    ).not.toBeNull();
    expect(scenario.calls.feature).toEqual([]);
  });

  it("adopts an orphan left between the Pi createTask commit and markAttemptRunning", async () => {
    const scenario = bootScenario();
    const db = scenario.appState.db;
    seedRun(scenario, "boot-orphan-adopt", "review");
    const first = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const claim = claimRun(scenario, "boot-orphan-adopt");
    const orphan = await first.handle.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      return tx.createTask(
        TestReviewTask,
        {
          workId: claim.run.work_id,
          attemptNo: claim.attempt.attempt_no,
          attemptId: claim.attempt.attempt_id,
        },
        { ownership: { kind: "conversation" }, conversationId: conversation.id },
      );
    }, BACKGROUND_CONTEXT);
    await crash(first);
    expect(attemptFor(db, "boot-orphan-adopt", 1)?.status).toBe("starting");

    const second = await openDurableRuntime(scenario.cfg, { tasks: TASKS });
    const service = await startService(scenario, second);
    expect(service.phaseA.schedulingDuringPhaseA).toEqual(["paused", "paused"]);
    expect(service.phaseA.adopted).toBe(1);
    expect(service.phaseA.resumedReviews).toEqual([
      { prKey: "o/r#boot-orphan-adopt", taskId: orphan },
    ]);
    expect(attemptFor(db, "boot-orphan-adopt", 1)?.task_id).toBe(String(orphan));
    const settled = await second.handle.harness.waitForTask(orphan, BACKGROUND_CONTEXT);
    expect(settled.state.outcome.status).toBe("completed");
    await eventually(() => workRunById(db, "boot-orphan-adopt")?.status === "completed");
    expect(workRunById(db, "boot-orphan-adopt")?.current_attempt_no).toBe(1);
    expect(scenario.calls.review).toEqual([]);
  });
});
