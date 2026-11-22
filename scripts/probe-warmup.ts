import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineTask,
  SubmissionSettled,
  type ConversationId,
  type Extension,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord/context";
import { openDurableHarness } from "../src/agent/runtime/durable/harness.ts";
import { conversationIdFromText } from "../src/agent/runtime/durable/harness.ts";
import {
  bindReviewChild,
  installReviewChild,
  reviewExtensionName,
  settledTurnKey,
  settledTurnSignalKey,
} from "../src/agent/runtime/durable/reviewConversations.ts";
import {
  executeStep,
  turnReader,
  type LiveAttempt,
} from "../src/agent/runtime/durable/reviewOrchestratorTask.ts";
import { openSqliteAppState } from "../test/integration/db.ts";
import { createScriptedModels, scriptedText } from "../test/helpers/executorDurableHarness.ts";
import { makeTestConfig } from "../test/helpers/config.ts";
import {
  createRuntimeExtension,
  type DurableRuntime,
} from "../src/agent/runtime/durable/runtime.ts";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  conversationIdFor,
  initialReviewCheckpoint,
  reviewChildRequest,
  REVIEW_CONVERSATION_ROLES,
  runReviewPhase,
  type ReviewAttemptCheckpoint,
  type ReviewAttemptLive,
} from "../src/review/orchestrator/orchestratorRun.ts";
import { seedRunningWorkRun } from "../test/helpers/executorDurableHarness.ts";
import { createEvidenceLedger } from "../src/review/findings/evidenceLedger.ts";
import type { AttemptStamp } from "../src/agent/runtime/durable/featureAttemptTask.ts";
import type { WorkerDeps } from "../src/agent/runtime/durable/workerDeps.ts";

type ProbeRuntime = TaskRuntime<AttemptStamp, { readonly phase: string }, unknown, object>;

const t0 = Date.now();
const events: string[] = [];
const log = (event: string) => {
  const line = `+${String(Date.now() - t0).padStart(6)}ms ${event}`;
  events.push(line);
  console.log(`  ${line}`);
};

function fakeLive(db: import("node:sqlite").DatabaseSync, workId: string) {
  const cfg = makeTestConfig({
    models: { provider: "stub", model: "stub-model" },
  });
  return {
    env: {
      cfg,
      db,
      item: {
        id: workId,
        resourceKey: "o/r#1",
        installationId: 42,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a".repeat(40),
        source: "slash",
        reviewLens: "review",
        payload: { source: "slash" },
      },
      target: {
        db,
        workItemId: workId,
        resourceKey: "o/r#1",
        laneEpoch: 0,
        shutdownRequested: () => false,
        signal: new AbortController().signal,
      },
      prSurface: {} as never,
      headSha: "a".repeat(40),
      baseSha: null,
      repositoryView: {
        agentCwd: process.cwd(),
        workspace: { reader: { changedFiles: [], isPathInCheckout: () => true } },
        preflight: {},
      } as never,
      trustedContext: "",
      repoPolicy: { kind: "absent" } as never,
      headCi: undefined as never,
      dispose: async () => {},
    },
    setup: {
      prSurface: {} as never,
      orchestratorUserContent: "",
      evidenceLedger: createEvidenceLedger("a".repeat(40)),
      specialistLedgers: {
        correctness: createEvidenceLedger("a".repeat(40)),
        security: createEvidenceLedger("a".repeat(40)),
        quality: createEvidenceLedger("a".repeat(40)),
        tests: createEvidenceLedger("a".repeat(40)),
      },
      trustedContext: "trusted",
    } as never,
    bindCheckpoint: () => {},
    inventory: {} as never,
    session: {} as never,
    briefTool: {} as never,
    publishThread: {} as never,
    summaryState: {} as never,
    orchestratorTools: { piTools: [], executors: {} },
    submitStates: new Map(),
    specialistTools: () => ({ piTools: [], executors: {} }),
    dispose: async () => {},
  } satisfies ReviewAttemptLive;
}

async function makeRuntime(sqliteDir: string, leadDelayMs: number) {
  let calls = 0;
  const models = createScriptedModels(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((r) => setTimeout(r, leadDelayMs));
      return scriptedText("lead done");
    }
    return scriptedText("done");
  });
  const registry = createRegistry();
  const sharedHeadByConversation = new Map<ConversationId, string>();
  const telemetry = new InMemoryTelemetryContext();
  let handle: Awaited<ReturnType<typeof openDurableHarness>>;
  const runtimeExtension: Extension = createRuntimeExtension({
    sharedHeadByConversation,
    harness: () => handle.harness,
  });
  registry.install(runtimeExtension);
  handle = await openDurableHarness({
    sqliteDir,
    registry,
    models: () => models,
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
    telemetry,
    settings: { extensions: [runtimeExtension] },
  });
  handle.resume();
  const runtime: DurableRuntime = {
    handle,
    registry,
    models: { models, credentials: new InMemoryCredentialStore() },
    telemetry,
    sharedHeadByConversation,
    codemodeExtension: runtimeExtension,
    runtimeExtension,
  };
  return runtime;
}

type DriverState = { readonly phase: "start" } | ReviewAttemptCheckpoint;

const drive = async (
  task: {
    input: { readonly attemptId: string; readonly workId: string; readonly caseName: string };
  },
  runtime: ProbeRuntime,
  context: Context,
  stored: ReviewAttemptCheckpoint | undefined,
) => {
  const rt = runtime;
  const deps = (globalThis as Record<string, unknown>).probeDepsStore as WorkerDeps & {
    runtime: DurableRuntime;
  };
  const attemptId = task.input.attemptId;
  const caseName = task.input.caseName;
  const stamp: AttemptStamp = { workId: task.input.workId, attemptNo: 1, attemptId };
  const attempts = ((globalThis as Record<string, unknown>).probeAttemptsStore ??= new Map<
    string,
    LiveAttempt
  >()) as Map<string, LiveAttempt>;
  const attempt =
    attempts.get(attemptId) ??
    (() => {
      const created: LiveAttempt = {
        live: fakeLive(deps.db, task.input.workId),
        controller: new AbortController(),
        children: new Map(),
      };
      attempts.set(attemptId, created);
      return created;
    })();
  const live = attempt.live;

  const checkpoint: ReviewAttemptCheckpoint =
    stored ??
    ({
      ...initialReviewCheckpoint({
        now: rt.now(),
        headSha: "a".repeat(40),
        baseSha: null,
        budgetMs: 300_000,
        finalizationMs: 30_000,
        reconBudgetMs: 60_000,
      }),
      phase: "dispatch_specialists",
      started: true,
      brief: {
        prIntent: "p",
        architectureNotes: "a",
        riskAreas: [],
        fileMap: "",
        specialistFocus: {
          correctness: "c",
          security: "s",
          quality: "q",
          tests: "t",
        },
      },
      specialistTiming: {
        deadlineAt: rt.now() + 60_000,
        wrapUpAt: rt.now() + 30_000,
      },
      ...(caseName === "expired-key"
        ? { warmup: { released: false, releaseAt: rt.now() - 1 } }
        : {}),
    } satisfies ReviewAttemptCheckpoint);

  for (const role of REVIEW_CONVERSATION_ROLES) {
    if (attempt.children.has(role)) continue;
    const storedId = conversationIdFor(checkpoint, role);
    if (storedId === undefined) continue;
    const id = conversationIdFromText(storedId);
    if (id === undefined) continue;
    const spec = reviewChildRequest(live, checkpoint, role);
    const child = installReviewChild(deps.runtime, {
      ...spec,
      extensionName: reviewExtensionName(attemptId, role),
    });
    await bindReviewChild(deps.runtime, id, child, () => {});
    attempt.children.set(role, { ...child, id });
  }

  const io = turnReader(rt, context, attemptId, (role) => attempt.children.get(role)?.id);

  if (caseName === "expired-key" && checkpoint.phase === "wait_specialists") {
    const correctnessTurn = checkpoint.specialists.correctness.turnNo - 1;
    if (correctnessTurn >= 0) {
      const signal = await rt.readSignal(
        SubmissionSettled,
        settledTurnKey("correctness", correctnessTurn),
        context,
      );
      if (signal === undefined) {
        log(`expired-key: expiring key correctness:${correctnessTurn} via immediate sleep`);
        await rt.commit(
          () => ({
            status: "sleeping",
            checkpoint,
            signals: [settledTurnSignalKey("correctness", correctnessTurn)],
            until: rt.now() - 1,
          }),
          context,
        );
        return;
      }
    }
  }

  const result = await runReviewPhase(live, checkpoint, io);
  log(`kind=${result.kind} phase=${result.checkpoint.phase} case=${caseName}`);
  if (result.kind === "advance" || result.kind === "finish") {
    log(`reached ${result.kind} phase=${result.checkpoint.phase}`);
    await rt.commit(
      () => ({
        status: "terminal",
        outcome: { status: "completed", result: { events } },
      }),
      context,
    );
    return;
  }
  await executeStep(deps, rt, context, stamp, attempt, result);
};

const driver = defineTask<
  { readonly attemptId: string; readonly workId: string; readonly caseName: string },
  DriverState,
  { readonly events: readonly string[] }
>({
  name: "probe.review-warmup-driver",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, undefined),
    recon: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, task.state.checkpoint),
    dispatch_specialists: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, task.state.checkpoint),
    wait_specialists: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, task.state.checkpoint),
    synthesize_and_validate: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, task.state.checkpoint),
    publish: (task, runtime, context) =>
      drive(task, runtime as unknown as ProbeRuntime, context, task.state.checkpoint),
  },
  abort: async () => {},
});

async function main() {
  const caseName = process.argv[2] ?? "slow-lead";
  const leadDelayMs = caseName === "slow-lead" ? 6_800 : caseName === "fast-lead" ? 400 : 6_800;
  const sqliteDir = mkdtempSync(join(tmpdir(), "probe-warmup-"));
  console.log(`case=${caseName} leadDelayMs=${leadDelayMs} sqliteDir=${sqliteDir}`);
  const runtime = await makeRuntime(sqliteDir, leadDelayMs);
  const app = openSqliteAppState();
  const run = seedRunningWorkRun(app.db, { kind: "review", workId: "wi-probe" });
  (globalThis as Record<string, unknown>).probeDepsStore = {
    db: app.db,
    runtime,
    cfg: makeTestConfig({ models: { provider: "stub", model: "stub-model" } }),
    installationSurface: {},
    shutdownRequested: () => false,
  } satisfies Partial<WorkerDeps> & { runtime: DurableRuntime };
  const { defineExtension } = await import("@earendil-works/pi-durable");
  runtime.registry.install(
    defineExtension({
      name: "probe-tasks",
      tasks: [driver],
    }),
  );
  const root = await runtime.handle.harness.root(BACKGROUND_CONTEXT);
  const taskId = await root.commit(
    (tx) =>
      tx.createTask(
        driver,
        { attemptId: "att-1", workId: run.run.work_id, caseName },
        { ownership: { kind: "conversation" } },
      ),
    BACKGROUND_CONTEXT,
  );
  const settled = await runtime.handle.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  console.log("settled:", JSON.stringify(settled.state.status));
  if (settled.state.status === "terminal") {
    const outcome = settled.state.outcome;
    console.log("outcome:", JSON.stringify(outcome).slice(0, 2000));
  }
  app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
