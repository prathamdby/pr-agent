import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createScriptedModels, scriptedText } from "../helpers/executorDurableHarness.ts";
import { mockLocalPrWorkspace } from "../helpers/mockWorkspace.ts";
import * as views from "../../src/prWorkspace/prRepositoryView.ts";
import { createReviewRunner } from "../../src/agent/runtime/durable/reviewOrchestratorTask.ts";
import { sessionStateFor } from "../../src/agent/runtime/durable/sessionState.ts";
import { DEFERRED_HEAD_SHA } from "../../src/settings/index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineTask,
  type ConversationId,
  type TaskId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { openAppState } from "../../src/state/db.ts";
import { applyAppStateSchema } from "../../src/state/schema.ts";
import { ensurePrState } from "../../src/state/intake.ts";
import { withPrMutex } from "../../src/state/prMutex.ts";
import {
  createPublishMutationBoundary,
  mutatingIntents,
  publishOnce,
} from "../../src/state/publish.ts";
import {
  attemptFor,
  bumpLaneEpoch,
  cancelWorkRun,
  claimDispatchableWorkRun,
  insertWorkRun,
  markWorkRunCompleted,
  workRunById,
} from "../../src/state/workRuns.ts";
import {
  createFakePrSurface,
  createPrSurface,
  withPrSurfaceMutationBoundary,
} from "../../src/github/prSurface.ts";
import {
  intentSurfaceFromWorkRuns,
  runBootPhaseA,
  runBootPhaseB,
  startDurableService,
} from "../../src/agent/runtime/durable/boot.ts";
import { createDispatcher } from "../../src/agent/runtime/durable/dispatcher.ts";
import { startAttemptTask } from "../../src/agent/runtime/durable/featureAttemptTask.ts";
import { openDurableRuntime } from "../../src/agent/runtime/durable/runtime.ts";
import { openInstallationSurface } from "../../src/agentWork/installationSurface.ts";
import { initEvlog } from "../../src/evlog.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { openSqliteAppState } from "./db.ts";

type PhaseTaskInput = {
  readonly workId: string;
  readonly attemptNo: number;
  readonly attemptId: string;
  readonly prKey: string;
  readonly checkoutDir: string;
};

type PhaseTaskState = {
  readonly phase: "recon" | "dispatch_specialists" | "synthesize" | "publish";
  readonly specialistIds?: readonly number[];
  readonly findings?: readonly string[];
};

type PhaseTaskResult = {
  readonly status: "completed";
  readonly phasesRan: readonly string[];
  readonly checkoutExistsAtEnd: boolean;
};

type CrashControl = {
  crashAfterPhase?: PhaseTaskState["phase"];
  deleteCheckoutBeforeSpecialists?: boolean;
  phasesExecuted: string[];
  onCrashPoint?: () => void;
  holdSpecialists?: {
    readonly spawned: Promise<readonly ConversationId[]>;
    readonly resolveSpawned: (ids: readonly ConversationId[]) => void;
    readonly release: Promise<void>;
  };
};

const SPECIALIST_ROLES = ["correctness", "security", "quality", "tests"] as const;

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
    },
  };
}

function makeDurableReviewTask(control: () => CrashControl) {
  const runPhase = async (
    task: {
      readonly id: TaskId;
      readonly input: PhaseTaskInput;
      readonly state: { readonly checkpoint: PhaseTaskState };
    },
    runtime: TaskRuntime<PhaseTaskInput, PhaseTaskState, PhaseTaskResult, object>,
    ctx: typeof BACKGROUND_CONTEXT,
  ) => {
    const active = control();
    const checkpoint = task.state.checkpoint;
    active.phasesExecuted.push(checkpoint.phase);

    if (checkpoint.phase === "recon") {
      mkdirSync(task.input.checkoutDir, { recursive: true });
      writeFileSync(join(task.input.checkoutDir, "recon.txt"), "hydrated");
      if (active.crashAfterPhase === "recon") {
        active.crashAfterPhase = undefined;
        active.onCrashPoint?.();
        await new Promise<void>((_, reject) => {
          runtime.signal.addEventListener("abort", () => reject(new Error("simulated crash")), {
            once: true,
          });
        });
        return;
      }
      await runtime.commit(
        () => ({
          status: "running" as const,
          checkpoint: { ...checkpoint, phase: "dispatch_specialists" as const },
        }),
        ctx,
      );
      return;
    }

    if (checkpoint.phase === "dispatch_specialists") {
      if (!existsSync(task.input.checkoutDir)) {
        mkdirSync(task.input.checkoutDir, { recursive: true });
        writeFileSync(join(task.input.checkoutDir, "rehydrated.txt"), "recovered");
      }
      const ids: ConversationId[] = [];
      await runtime.commit(async (tx) => {
        for (const _role of SPECIALIST_ROLES) {
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: task.id },
          });
          ids.push(child.id);
        }
        return undefined;
      }, ctx);
      if (active.holdSpecialists !== undefined) {
        active.holdSpecialists.resolveSpawned(ids);
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted during specialists"));
          if (runtime.signal.aborted) {
            onAbort();
            return;
          }
          runtime.signal.addEventListener("abort", onAbort, { once: true });
          void active.holdSpecialists?.release.then(() => {
            runtime.signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
      if (active.crashAfterPhase === "dispatch_specialists") {
        active.crashAfterPhase = undefined;
        await runtime.commit(
          () => ({
            status: "running" as const,
            checkpoint: {
              phase: "synthesize" as const,
              specialistIds: ids.map(Number),
              findings: ["finding-a", "finding-b"],
            },
          }),
          ctx,
        );
        active.onCrashPoint?.();
        await new Promise<void>((_, reject) => {
          runtime.signal.addEventListener("abort", () => reject(new Error("simulated crash")), {
            once: true,
          });
        });
        return;
      }
      await runtime.commit(
        () => ({
          status: "running" as const,
          checkpoint: {
            phase: "synthesize" as const,
            specialistIds: ids.map(Number),
            findings: ["finding-a", "finding-b"],
          },
        }),
        ctx,
      );
      return;
    }

    if (checkpoint.phase === "synthesize") {
      if (active.crashAfterPhase === "synthesize") {
        active.crashAfterPhase = undefined;
        active.onCrashPoint?.();
        await new Promise<void>((_, reject) => {
          runtime.signal.addEventListener("abort", () => reject(new Error("simulated crash")), {
            once: true,
          });
        });
        return;
      }
      await runtime.commit(
        () => ({
          status: "running" as const,
          checkpoint: { ...checkpoint, phase: "publish" as const },
        }),
        ctx,
      );
      return;
    }

    await runtime.commit(
      () => ({
        status: "terminal" as const,
        outcome: {
          status: "completed" as const,
          result: {
            status: "completed" as const,
            phasesRan: [...active.phasesExecuted],
            checkoutExistsAtEnd: existsSync(task.input.checkoutDir),
          },
        },
      }),
      ctx,
    );
  };

  return defineTask<PhaseTaskInput, PhaseTaskState, PhaseTaskResult>({
    name: "pr.test_durable_review",
    version: 1,
    initial: () => ({ phase: "recon" }),
    phases: {
      recon: runPhase,
      dispatch_specialists: runPhase,
      synthesize: runPhase,
      publish: runPhase,
    },
    abort: async (task, runtime, ctx) => {
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "aborted" as const, reason: task.input.workId },
        }),
        ctx,
      );
    },
  });
}

describe("durable review recovery, PR mutex, and publish fence (sqlite integration)", () => {
  const dirs: string[] = [];

  function tempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the production review's tools, evidence, spent budget and pinned policy before retrying its interrupted request", async () => {
    const sqliteDir = tempDir("review-restore-");
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const cfg = makeTestConfig({
      runtime: { sqliteDir, shutdownGraceMs: 50 },
      models: { provider: "stub", model: "stub-model" },
      retention: { enabled: false },
    });
    const pr = { owner: "o", repo: "r", prNumber: 1 };
    const surface = createFakePrSurface(pr, {
      headSha,
      pullRequest: {
        title: "",
        body: null,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        base: { sha: baseSha },
        head: { sha: headSha },
      },
    }).surface;
    const installationSurface = {
      ...openInstallationSurface(),
      create: async () => surface,
      botIdentity: async () => ({ login: "pr-agent[bot]", userId: 999 }),
    };
    const acquire = vi.spyOn(views, "openPrRepositoryView").mockImplementation(async () => {
      const agentCwd = tempDir("pinned-review-");
      writeFileSync(join(agentCwd, "source.ts"), "pinned line\n");
      const workspace = mockLocalPrWorkspace(agentCwd, {
        headSha,
        checkoutPaths: new Set(["source.ts"]),
      });
      return {
        workspace: {
          ...workspace,
          reader: { ...workspace.reader, isPathInCheckout: (p) => p === "source.ts" },
        },
        agentCwd,
        reused: false,
        preflight: {
          files: [{ filename: "source.ts" }],
          truncated: false,
          fileCount: 1,
          totalChanges: 1,
        },
        release: async () => {},
      };
    });
    const attempts: string[] = [];
    const submissions: number[] = [];
    const spentCalls: number[][] = [];
    const toolsets: string[][] = [];
    try {
      for (const stage of ["start", "restart"]) {
        const appState = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
        const { db } = appState;
        if (stage === "start") {
          ensurePrState(db, "o/r#1", Date.now());
          insertWorkRun(db, {
            workId: "review",
            prKey: "o/r#1",
            kind: "review",
            laneEpoch: 0,
            payloadJson: JSON.stringify({
              ...pr,
              installationId: 1,
              headSha: DEFERRED_HEAD_SHA,
              source: "slash",
            }),
            now: Date.now(),
          });
        }
        const runtime = await openDurableRuntime(cfg);
        const requested = deferred<string[]>();
        const stub = createScriptedModels(async (_model, transcript) => {
          if (!transcript.messages.some((m) => m.role === "toolResult")) {
            return {
              message: {
                ...scriptedText("").message,
                stopReason: "toolUse",
                content: [
                  {
                    type: "toolCall",
                    id: "read-source",
                    name: "read_pinned",
                    arguments: { path: "source.ts" },
                  },
                ],
              },
            };
          }
          requested.resolve(getCurrentTools(transcript.messages).map((tool) => tool.name));
          return new Promise(() => {});
        }).getProvider("stub");
        if (!stub) throw new Error("missing scripted provider");
        runtime.models.models.setProvider(stub);
        const service = await startDurableService({
          appState,
          cfg,
          runtime,
          installationSurface,
          reopenRuntime: () => openDurableRuntime(cfg),
          createHandlers: (deps) => ({
            review: createReviewRunner(deps),
            feature: () => async () => {},
            ack: async () => {},
          }),
        });
        try {
          toolsets.push(await requested.promise);
          const attempt = attemptFor(db, "review", 1);
          if (!attempt) throw new Error("missing attempt");
          attempts.push(attempt.attempt_id);
          const inspection = await runtime.handle.harness.inspect(BACKGROUND_CONTEXT);
          const submission = inspection.submissions.find(
            (s) => s.requestId === `${attempt.attempt_id}:orchestrator:0`,
          );
          if (!submission) throw new Error("missing recon submission");
          submissions.push(submission.id);
          const state = sessionStateFor(submission.conversationId);
          const child = await runtime.handle.harness.conversation(
            submission.conversationId,
            BACKGROUND_CONTEXT,
          );
          expect((await child?.agent(BACKGROUND_CONTEXT))?.cwd).toEqual(
            (await acquire.mock.results.at(-1)?.value)?.agentCwd,
          );
          const counted = [...(state?.currentSend?.countedCalls ?? [])];
          expect(counted).toHaveLength(1);
          spentCalls.push(counted);
          expect(state?.evidence.attempts.get("read-source")?.[0]?.content).toContain(
            "pinned line",
          );
          expect(service.phaseA.resumedReviews).toHaveLength(stage === "start" ? 0 : 1);
        } finally {
          await service.shutdown("test restart");
        }
      }
      expect(new Set(attempts).size).toBe(1);
      expect(new Set(submissions).size).toBe(1);
      expect(spentCalls[1]).toEqual(spentCalls[0]);
      expect(toolsets[0]).toContain("codemode");
      expect(toolsets[1]).toEqual(toolsets[0]);
      expect(acquire.mock.calls.map(([input]) => [input.headSha, input.baseSha])).toEqual([
        [headSha, baseSha],
        [headSha, baseSha],
      ]);
    } finally {
      acquire.mockRestore();
    }
  });

  it("recovers a multi-phase durable review task across crash mid-recon, mid-specialist with deleted checkout, and mid-synthesis", async () => {
    const sqliteDir = tempDir("pr-agent-durable-crash-");
    const checkoutDir = tempDir("pr-agent-checkout-");
    const appState = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
    const db = appState.db;
    const cfg = makeTestConfig({ runtime: { sqliteDir } });
    const workId = randomUUID();
    const prKey = "acme/app#42";
    const now = Date.now();
    ensurePrState(db, prKey, now);
    insertWorkRun(db, {
      workId,
      prKey,
      kind: "review",
      laneEpoch: 0,
      payloadJson: JSON.stringify({ headSha: "a".repeat(40) }),
      now,
    });
    const claim = claimDispatchableWorkRun(db, now, { kinds: ["review"] });
    if (claim === undefined) throw new Error("expected claimable review work run");

    let control: CrashControl = { phasesExecuted: [] };
    const DurableReviewTask = makeDurableReviewTask(() => control);

    try {
      const reconCrash = deferred<void>();
      control = {
        crashAfterPhase: "recon",
        phasesExecuted: [],
        onCrashPoint: () => reconCrash.resolve(),
      };
      const runtime1 = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
      runtime1.handle.resume();
      const started = await startAttemptTask({
        harness: runtime1.handle.harness,
        db,
        claim,
        task: DurableReviewTask,
        input: {
          workId,
          attemptNo: claim.attempt.attempt_no,
          attemptId: claim.attempt.attempt_id,
          prKey,
          checkoutDir,
        },
        context: BACKGROUND_CONTEXT,
      });
      expect(started.markedRunning).toBe(true);
      await reconCrash.promise;
      await runtime1.handle.harness.close(BACKGROUND_CONTEXT);
      await runtime1.handle.closed;

      rmSync(checkoutDir, { recursive: true, force: true });
      expect(existsSync(checkoutDir)).toBe(false);

      const synthCrash = deferred<void>();
      control = {
        crashAfterPhase: "synthesize",
        phasesExecuted: [],
        onCrashPoint: () => synthCrash.resolve(),
      };
      const runtime2 = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
      const phaseA2 = await runBootPhaseA({
        db,
        cfg,
        runtime: runtime2,
        reviewTaskName: DurableReviewTask.definition.name,
      });
      expect(phaseA2.schedulingDuringPhaseA).toEqual(["paused", "paused"]);
      expect(phaseA2.resumedReviews).toEqual([{ prKey, taskId: started.taskId }]);
      const dispatcher2 = createDispatcher({
        db,
        cfg,
        startAttempt: async () => undefined,
        ack: async () => {},
        runtime: () => runtime2,
      });
      await runBootPhaseB({ runtime: runtime2, phaseA: phaseA2, dispatcher: dispatcher2 });
      await synthCrash.promise;
      dispatcher2.pause();
      await runtime2.handle.harness.close(BACKGROUND_CONTEXT);
      await runtime2.handle.closed;
      expect(control.phasesExecuted).toEqual(["recon", "dispatch_specialists", "synthesize"]);
      expect(existsSync(join(checkoutDir, "recon.txt"))).toBe(true);

      control = { phasesExecuted: [] };
      const runtime3 = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
      const phaseA3 = await runBootPhaseA({
        db,
        cfg,
        runtime: runtime3,
        reviewTaskName: DurableReviewTask.definition.name,
      });
      expect(phaseA3.schedulingDuringPhaseA).toEqual(["paused", "paused"]);
      expect(phaseA3.resumedReviews).toEqual([{ prKey, taskId: started.taskId }]);
      runtime3.handle.resume();
      const finished = await runtime3.handle.harness.waitForTask(
        started.taskId,
        BACKGROUND_CONTEXT,
      );
      expect(finished.state.status).toBe("terminal");
      if (finished.state.status !== "terminal") throw new Error("expected terminal task");
      expect(finished.state.outcome.status).toBe("completed");
      if (finished.state.outcome.status !== "completed") throw new Error("expected completed");
      expect(control.phasesExecuted).toEqual(["synthesize", "publish"]);
      expect(finished.state.outcome.result).toMatchObject({
        status: "completed",
        checkoutExistsAtEnd: true,
      });
      await runtime3.handle.harness.close(BACKGROUND_CONTEXT);
      await runtime3.handle.closed;
    } finally {
      appState.close();
    }
  });

  it("cascades root conversation abort to all four task-owned specialist child conversations", async () => {
    const sqliteDir = tempDir("pr-agent-abort-cascade-");
    const checkoutDir = tempDir("pr-agent-abort-checkout-");
    const cfg = makeTestConfig({ runtime: { sqliteDir } });
    const spawned = deferred<readonly ConversationId[]>();
    const release = deferred<void>();
    const control: CrashControl = {
      phasesExecuted: [],
      holdSpecialists: {
        spawned: spawned.promise,
        resolveSpawned: spawned.resolve,
        release: release.promise,
      },
    };
    const DurableReviewTask = makeDurableReviewTask(() => control);
    const runtime = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
    try {
      runtime.handle.resume();
      const started = await runtime.handle.harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(
          DurableReviewTask,
          {
            workId: "w-abort",
            attemptNo: 1,
            attemptId: "att-abort",
            prKey: "acme/app#7",
            checkoutDir,
          },
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
        return { conversationId: conversation.id, taskId };
      }, BACKGROUND_CONTEXT);
      const childIds = await spawned.promise;
      expect(childIds).toHaveLength(4);

      const rootConv = await runtime.handle.harness.conversation(
        started.conversationId,
        BACKGROUND_CONTEXT,
      );
      if (rootConv === undefined) throw new Error("expected root conversation");
      await rootConv.abort(BACKGROUND_CONTEXT);
      const outcome = await runtime.handle.harness.waitForTask(started.taskId, BACKGROUND_CONTEXT);
      expect(outcome.state.status).toBe("terminal");
      if (outcome.state.status === "terminal") {
        expect(outcome.state.outcome.status).toBe("aborted");
      }
      const inspection = await runtime.handle.harness.inspect(BACKGROUND_CONTEXT);
      expect(inspection.tasks).toHaveLength(0);
      expect(inspection.submissions).toHaveLength(0);
      for (const childId of childIds) {
        const child = await runtime.handle.harness.conversation(childId, BACKGROUND_CONTEXT);
        expect(child).toBeDefined();
        await child?.waitForIdle(BACKGROUND_CONTEXT);
      }
      const ownedAfter = await runtime.handle.harness.commit(async (tx) => {
        const page = await tx.scanConversations({ ownerTaskId: started.taskId }, 16);
        return page.items.map((item) => item.id);
      }, BACKGROUND_CONTEXT);
      expect(ownedAfter).toHaveLength(4);
    } finally {
      release.resolve();
      await runtime.handle.harness.close(BACKGROUND_CONTEXT);
      await runtime.handle.closed;
    }
  });

  it("adopts an orphaned durable task and aborts superseded tasks across Phase A/Phase B boot without waking Pi before resume", async () => {
    const sqliteDir = tempDir("pr-agent-orphan-boot-");
    const checkoutDir = tempDir("pr-agent-orphan-checkout-");
    const appState = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
    const db = appState.db;
    const cfg = makeTestConfig({ runtime: { sqliteDir } });
    const now = Date.now();
    ensurePrState(db, "acme/app#1", now);
    ensurePrState(db, "acme/app#2", now);

    insertWorkRun(db, {
      workId: "w-adopt",
      prKey: "acme/app#1",
      kind: "review",
      laneEpoch: 0,
      payloadJson: "{}",
      now,
    });
    insertWorkRun(db, {
      workId: "w-superseded",
      prKey: "acme/app#2",
      kind: "review",
      laneEpoch: 0,
      payloadJson: "{}",
      now: now + 1,
    });
    const adoptClaim = claimDispatchableWorkRun(db, now + 2, { kinds: ["review"] });
    const superClaim = claimDispatchableWorkRun(db, now + 3, { kinds: ["review"] });
    if (adoptClaim === undefined || superClaim === undefined) {
      throw new Error("expected two claimed work runs");
    }

    const control: CrashControl = { phasesExecuted: [] };
    const DurableReviewTask = makeDurableReviewTask(() => control);
    try {
      const runtime1 = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
      const adoptStarted = await runtime1.handle.harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(
          DurableReviewTask,
          {
            workId: adoptClaim.run.work_id,
            attemptNo: adoptClaim.attempt.attempt_no,
            attemptId: adoptClaim.attempt.attempt_id,
            prKey: adoptClaim.run.pr_key,
            checkoutDir,
          },
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
        return { conversationId: conversation.id, taskId };
      }, BACKGROUND_CONTEXT);
      const superStarted = await startAttemptTask({
        harness: runtime1.handle.harness,
        db,
        claim: superClaim,
        task: DurableReviewTask,
        input: {
          workId: superClaim.run.work_id,
          attemptNo: superClaim.attempt.attempt_no,
          attemptId: superClaim.attempt.attempt_id,
          prKey: superClaim.run.pr_key,
          checkoutDir,
        },
        context: BACKGROUND_CONTEXT,
        now: now + 4,
      });
      bumpLaneEpoch(db, { prKey: "acme/app#2", lane: "review", now: now + 5 });
      await runtime1.handle.harness.close(BACKGROUND_CONTEXT);
      await runtime1.handle.closed;

      const runtime2 = await openDurableRuntime(cfg, { tasks: [DurableReviewTask] });
      const phaseA = await runBootPhaseA({
        db,
        cfg,
        runtime: runtime2,
        reviewTaskName: DurableReviewTask.definition.name,
      });
      expect(phaseA.schedulingDuringPhaseA).toEqual(["paused", "paused"]);
      expect(phaseA.adopted).toBe(1);
      expect(phaseA.cancelled).toBe(1);
      expect(phaseA.toAbort).toContain(superStarted.taskId);
      expect(phaseA.resumedReviews).toEqual([{ prKey: "acme/app#1", taskId: adoptStarted.taskId }]);
      expect(attemptFor(db, "w-adopt", 1)?.task_id).toBe(String(adoptStarted.taskId));
      expect(attemptFor(db, "w-superseded", 1)?.status).toBe("cancelled");
      expect(workRunById(db, "w-superseded")?.status).toBe("superseded");

      const dispatcher = createDispatcher({
        db,
        cfg,
        startAttempt: async () => undefined,
        ack: async () => {},
        runtime: () => runtime2,
      });
      try {
        await runBootPhaseB({ runtime: runtime2, phaseA, dispatcher });
        const [adoptedFinal, supersededFinal] = await Promise.all([
          runtime2.handle.harness.waitForTask(adoptStarted.taskId, BACKGROUND_CONTEXT),
          runtime2.handle.harness.waitForTask(superStarted.taskId, BACKGROUND_CONTEXT),
        ]);
        expect(adoptedFinal.state.status === "terminal" && adoptedFinal.state.outcome.status).toBe(
          "completed",
        );
        expect(
          supersededFinal.state.status === "terminal" && supersededFinal.state.outcome.status,
        ).toBe("aborted");
      } finally {
        await dispatcher.drain();
        await runtime2.handle.harness.close(BACKGROUND_CONTEXT);
        await runtime2.handle.closed;
      }
    } finally {
      appState.close();
    }
  });

  it("serializes review, description, triage, and verification per PR while allowing different PRs in parallel", async () => {
    const activeByPr = new Map<string, number>();
    let maxSamePr = 0;
    let totalActive = 0;
    let maxTotal = 0;
    const order: string[] = [];

    const run = (prKey: string, kind: string, delayMs: number) =>
      withPrMutex(prKey, async () => {
        const nextPr = (activeByPr.get(prKey) ?? 0) + 1;
        activeByPr.set(prKey, nextPr);
        maxSamePr = Math.max(maxSamePr, nextPr);
        totalActive += 1;
        maxTotal = Math.max(maxTotal, totalActive);
        order.push(`start:${prKey}:${kind}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`end:${prKey}:${kind}`);
        totalActive -= 1;
        activeByPr.set(prKey, (activeByPr.get(prKey) ?? 1) - 1);
      });

    await Promise.all([
      run("acme/app#1", "review", 20),
      run("acme/app#1", "description", 15),
      run("acme/app#1", "triage", 15),
      run("acme/app#1", "verification", 15),
      run("acme/app#2", "review", 40),
    ]);

    expect(maxSamePr).toBe(1);
    expect(maxTotal).toBe(2);
    expect(order.filter((entry) => entry.includes("acme/app#1"))).toEqual([
      "start:acme/app#1:review",
      "end:acme/app#1:review",
      "start:acme/app#1:description",
      "end:acme/app#1:description",
      "start:acme/app#1:triage",
      "end:acme/app#1:triage",
      "start:acme/app#1:verification",
      "end:acme/app#1:verification",
    ]);
  });

  it("keeps both review slots occupied after restart until a resumed task settles", async () => {
    const state = openSqliteAppState();
    const db = state.db;
    const cfg = makeTestConfig({
      runtime: { sqliteDir: state.sqliteDir },
      concurrency: { review: 2 },
    });
    const checkoutDir = tempDir("pr-agent-restart-slots-");
    const now = Date.now();
    const release = deferred<void>();
    const dispatched = deferred<string>();
    const control: CrashControl = {
      phasesExecuted: [],
      holdSpecialists: {
        spawned: Promise.resolve([]),
        resolveSpawned: () => {},
        release: release.promise,
      },
    };
    const task = makeDurableReviewTask(() => control);
    try {
      const before = await openDurableRuntime(cfg, { tasks: [task] });
      try {
        for (const n of [1, 2, 3]) {
          const prKey = `acme/app#${String(n)}`;
          ensurePrState(db, prKey, now);
          insertWorkRun(db, {
            workId: `review-${String(n)}`,
            prKey,
            kind: "review",
            payloadJson: "{}",
            now,
          });
        }
        for (const n of [1, 2]) {
          const claim = claimDispatchableWorkRun(db, now, { kinds: ["review"] });
          if (claim === undefined) throw new Error("expected a review to persist before restart");
          const started = await startAttemptTask({
            harness: before.handle.harness,
            context: BACKGROUND_CONTEXT,
            db,
            claim,
            task,
            input: {
              workId: claim.run.work_id,
              attemptNo: claim.attempt.attempt_no,
              attemptId: claim.attempt.attempt_id,
              prKey: claim.run.pr_key,
              checkoutDir: join(checkoutDir, String(n)),
            },
          });
          expect(started.markedRunning).toBe(true);
        }
      } finally {
        await before.handle.harness.close(BACKGROUND_CONTEXT);
        await before.handle.closed;
      }

      const after = await openDurableRuntime(cfg, { tasks: [task] });
      const dispatcher = createDispatcher({
        db,
        cfg,
        runtime: () => after,
        startAttempt: async (claim) => {
          dispatched.resolve(claim.run.work_id);
          return undefined;
        },
        ack: async () => {},
      });
      try {
        const phaseA = await runBootPhaseA({
          db,
          cfg,
          runtime: after,
          reviewTaskName: task.definition.name,
        });
        expect(phaseA.resumedReviews).toHaveLength(2);
        await runBootPhaseB({ runtime: after, phaseA, dispatcher });
        expect(workRunById(db, "review-3")?.current_attempt_no).toBe(0);
        expect(dispatcher.inflightCount("review")).toBe(2);
        release.resolve();
        await expect(dispatched.promise).resolves.toBe("review-3");
      } finally {
        release.resolve();
        await dispatcher.drain();
        await after.handle.harness.close(BACKGROUND_CONTEXT);
        await after.handle.closed;
      }
    } finally {
      state.close();
    }
  });

  it("requests a separate repository credential for each intent recovery surface", async () => {
    const state = openSqliteAppState();
    const db = state.db;
    const cfg = makeTestConfig();
    const scopes: (string[] | undefined)[] = [];
    const installationSurface = openInstallationSurface({
      mintToken: async (_cfg, _id, options) => {
        scopes.push(options?.repositories);
        return { token: "test-token", expiresAtTs: Date.now() + 3_600_000, ttlMs: 3_600_000 };
      },
      resolveBot: async () => ({ userId: 1, login: "pr-agent[bot]" }),
      surface: createPrSurface,
      now: Date.now,
    });
    const surfaceFor = intentSurfaceFromWorkRuns({ db, cfg, installationSurface });
    try {
      for (const repo of ["one", "two"]) {
        const workId = `recovery-${repo}`;
        const prKey = `acme/${repo}#1`;
        insertWorkRun(db, {
          workId,
          prKey,
          kind: "ack",
          payloadJson: JSON.stringify({ installationId: 9, owner: "acme", repo, prNumber: 1 }),
          now: Date.now(),
        });
        db.prepare("UPDATE work_runs SET status = 'running' WHERE work_id = ?").run(workId);
        await publishOnce({
          db,
          workId,
          prKey,
          resourceTarget: "comment:1",
          operationKey: "recover",
          mutationKind: "github.test",
          mutate: async () => {
            const intent = mutatingIntents(db)[0];
            if (intent === undefined) throw new Error("no intent to recover");
            const surface = surfaceFor(intent);
            if (surface === undefined) throw new Error("no recovery surface");
            await surface.gitCredentialAuth();
          },
        });
      }
      expect(scopes).toEqual([["one"], ["two"]]);
    } finally {
      state.close();
    }
  });

  it("fences PrSurface mutations on epoch advance, cancellation, and fail-closed labels/commit status while leaving reads open", async () => {
    const state = openSqliteAppState();
    const db = state.db;
    try {
      const now = Date.now();
      const prKey = "acme/app#99";
      const workId = "w-fence";
      ensurePrState(db, prKey, now);
      db.prepare(`UPDATE pr_state SET auto_review_epoch = 3 WHERE pr_key = ?`).run(prKey);
      insertWorkRun(db, {
        workId,
        prKey,
        kind: "review",
        laneEpoch: 3,
        payloadJson: "{}",
        now,
      });
      db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(workId);

      const { surface, controls } = createFakePrSurface({
        owner: "acme",
        repo: "app",
        prNumber: 99,
      });
      const boundary = createPublishMutationBoundary({
        db,
        workId,
        prKey,
        laneEpoch: 3,
      });
      const wrapped = withPrSurfaceMutationBoundary(surface, boundary);
      expect(withPrSurfaceMutationBoundary(surface, boundary)).toBe(wrapped);

      await wrapped.replyAt({ kind: "prConversation", prNumber: 99 }, "hello");
      expect(controls.replies).toHaveLength(1);

      bumpLaneEpoch(db, { prKey, lane: "review", now: now + 10 });
      await expect(
        wrapped.replyAt({ kind: "prConversation", prNumber: 99 }, "stale"),
      ).rejects.toMatchObject({ code: "operation_intent.mutation_gate_failed" });
      await expect(wrapped.getHeadSha()).resolves.toBeTruthy();

      db.prepare(`UPDATE pr_state SET auto_review_epoch = 3 WHERE pr_key = ?`).run(prKey);
      cancelWorkRun(db, { workId, reason: "cancelled", now: now + 20 });
      await expect(wrapped.setLabels(["size/S"])).rejects.toMatchObject({
        code: "operation_intent.mutation_gate_failed",
      });
      await expect(wrapped.getHead()).resolves.toBeTruthy();
      expect(controls.replies).toHaveLength(1);
    } finally {
      state.close();
    }
  });

  it("defers pi_durable reset while a mutating publish intent exists and succeeds once quiescent without 503", async () => {
    initEvlog("error", { silent: true, suppressDrainWarning: true });
    const sqliteDir = tempDir("pr-agent-reset-quiesce-");
    const appState = openAppState({ sqliteDir, applySchema: applyAppStateSchema });
    const db = appState.db;
    const cfg = makeTestConfig({
      runtime: {
        sqliteDir,
        shutdownGraceMs: 2_000,
      },
      retention: { enabled: false },
    });
    const runtime = await openDurableRuntime(cfg);
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
    try {
      const now = Date.now();
      ensurePrState(db, "acme/app#5", now);
      insertWorkRun(db, {
        workId: "w-reset",
        prKey: "acme/app#5",
        kind: "ack",
        payloadJson: "{}",
        now,
      });
      db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run("w-reset");
      const releaseMutation = deferred<void>();
      const enteredMutation = deferred<void>();
      const inflight = publishOnce({
        db,
        workId: "w-reset",
        prKey: "acme/app#5",
        resourceTarget: "ack_reply",
        operationKey: "ack:reset-test",
        mutationKind: "github.ack_reply",
        allowsUndefinedResult: true,
        decodeResult: () => undefined,
        mutate: async () => {
          enteredMutation.resolve();
          await releaseMutation.promise;
        },
      });
      await enteredMutation.promise;
      expect(mutatingIntents(db)).toHaveLength(1);
      expect(service.acceptingWebhooks()).toBe(true);

      const blockedReset = await service.checkReset("size");
      expect(blockedReset.kind).toBe("not_quiescent");
      expect(service.acceptingWebhooks()).toBe(true);

      releaseMutation.resolve();
      await inflight;
      expect(mutatingIntents(db)).toHaveLength(0);
      db.prepare(`UPDATE work_runs SET status = 'completed' WHERE work_id = ?`).run("w-reset");
      expect(workRunById(db, "w-reset")?.status).toBe("completed");
      markWorkRunCompleted(db, { workId: "w-reset", attemptNo: 1, now: Date.now() });

      const cleanReset = await service.checkReset("size");
      expect(cleanReset.kind).toBe("reset");
      expect(service.acceptingWebhooks()).toBe(true);
    } finally {
      await service.shutdown("test_done");
    }
  });
});
