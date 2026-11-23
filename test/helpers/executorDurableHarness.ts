import type { AgentWorkItem, AgentWorkItemCore } from "../../src/agentWork/types.ts";
import {
  createFakePrSurface,
  type FakePrSurfaceControls,
  type PrReviewComment,
} from "../../src/github/prSurface.ts";
import { VERIFICATION_STUB_MARKER } from "../../src/settings/index.ts";
import { renderReviewPointerLensMarker } from "../../src/review/run/reviewRender.ts";
import type { BotFindingThread } from "../../src/review/run/reviewPriorFeedback.ts";

export type WorkClaim = {
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly attemptCount: number;
  readonly resumed: boolean;
};

let durableSurfaceBundle = createFakePrSurface(
  { owner: "o", repo: "r", prNumber: 1 },
  { headSha: "head", credentialToken: "tok" },
);

export function resetDurablePrSurface(
  params: { owner?: string; repo?: string; prNumber?: number; headSha?: string } = {},
) {
  seededComments = [];
  durableSurfaceBundle = createFakePrSurface(
    {
      owner: params.owner ?? "o",
      repo: params.repo ?? "r",
      prNumber: params.prNumber ?? 1,
    },
    { headSha: params.headSha ?? "head", credentialToken: "tok" },
  );
  return durableSurfaceBundle;
}

export function durablePrSurfaceControls() {
  return ((pinnedReturn: FakePrSurfaceControls) => pinnedReturn)(durableSurfaceBundle.controls);
}

const SEEDED_BOT_USER_ID = 999;
let seededComments: PrReviewComment[] = [];

function seedComment(comment: Partial<PrReviewComment> & Pick<PrReviewComment, "id" | "body">) {
  return ((pinnedReturn: PrReviewComment) => pinnedReturn)({
    inReplyToId: null,
    pullRequestReviewId: null,
    userId: null,
    authorLogin: "someone",
    authorAssociation: null,
    path: null,
    line: null,
    originalLine: null,
    htmlUrl: "",
    ...comment,
  });
}

export function seedBotFindingThreads(
  threads: readonly BotFindingThread[],
  controls: FakePrSurfaceControls = durablePrSurfaceControls(),
) {
  seededComments = [];
  controls.setPullRequestReviews(
    threads.map((thread) => ({
      id: 10_000 + thread.rootCommentId,
      userId: SEEDED_BOT_USER_ID,
      authorLogin: "pr-agent[bot]",
      body: renderReviewPointerLensMarker(thread.lens),
      commitId: null,
      htmlUrl: "",
      state: "COMMENTED",
    })),
  );
  let nextReplyId = 100_000;
  for (const thread of threads) {
    const titleMatch = /^(P[0-3]) · (.*)$/.exec(thread.titleSnippet);
    seededComments.push(
      seedComment({
        id: thread.rootCommentId,
        userId: SEEDED_BOT_USER_ID,
        authorLogin: "pr-agent[bot]",
        pullRequestReviewId: 10_000 + thread.rootCommentId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.line,
        htmlUrl: thread.threadUrl,
        body: titleMatch ? `**${titleMatch[1]}** · **${titleMatch[2]}**` : thread.titleSnippet,
      }),
    );
    for (const reply of thread.humanReplies) {
      seededComments.push(
        seedComment({
          id: nextReplyId++,
          inReplyToId: thread.rootCommentId,
          userId: 7,
          body: reply,
        }),
      );
    }
    if (thread.hasTriageReply === true) {
      seededComments.push(
        seedComment({
          id: nextReplyId++,
          inReplyToId: thread.rootCommentId,
          userId: SEEDED_BOT_USER_ID,
          body: "**Triage**: handled",
        }),
      );
    }
    if (thread.verificationStubCommentId != null) {
      seededComments.push(
        seedComment({
          id: thread.verificationStubCommentId,
          inReplyToId: thread.rootCommentId,
          userId: SEEDED_BOT_USER_ID,
          body: `${VERIFICATION_STUB_MARKER}\n**Verification**: stub`,
        }),
      );
    }
  }
  controls.setReviewComments(seededComments);
}

export function seedReviewCommentGraph(
  nodes: readonly { readonly id: number; readonly inReplyToId: number | null }[],
) {
  for (const node of nodes) {
    if (seededComments.some((comment) => comment.id === node.id)) continue;
    seededComments.push(seedComment({ id: node.id, inReplyToId: node.inReplyToId, body: "" }));
  }
  durablePrSurfaceControls().setReviewComments(seededComments);
}

export function fakeDurablePrSurface(
  params: { owner?: string; repo?: string; prNumber?: number } = {},
) {
  if (
    params.owner != null &&
    (params.owner !== "o" || params.repo !== "r" || params.prNumber !== 1)
  ) {
    return createFakePrSurface({
      owner: params.owner ?? "o",
      repo: params.repo ?? "r",
      prNumber: params.prNumber ?? 1,
    }).surface;
  }
  return durableSurfaceBundle.surface;
}

export function coreOf(item: AgentWorkItem) {
  switch (item.type) {
    case "review": {
      const { payload: _payload, ...core } = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(core);
    }
    case "ask": {
      const { payload: _payload, ...core } = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(core);
    }
    case "description": {
      const { payload: _payload, ...core } = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(core);
    }
    case "triage": {
      const { payload: _payload, ...core } = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(core);
    }
    case "verification": {
      const { payload: _payload, ...core } = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(core);
    }
    default: {
      const exhaustive: never = item;
      return ((pinnedReturn: AgentWorkItemCore) => pinnedReturn)(exhaustive);
    }
  }
}

export function mockWorkClaim(overrides: Partial<WorkClaim> = {}) {
  return ((pinnedReturn: WorkClaim) => pinnedReturn)({
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:05.000Z"),
    attemptCount: 1,
    resumed: false,
    ...overrides,
  });
}

export function makeDurableJobMetadata(workItemId = "wi-1", retryCount = 0, retryLimit = 3) {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work",
    data: { workItemId },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active" as const,
    retryLimit,
    retryCount,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 0,
    createdOn: now,
    completedOn: null,
    keepUntil: now,
    policy: "standard" as const,
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: "",
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
    sourceOutput: null,
    sourceRootId: null,
  };
}

import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type MutableModels,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  type Extension,
  type ConversationId,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import {
  createRuntimeExtension,
  type DurableRuntime,
} from "../../src/agent/runtime/durable/runtime.ts";
import { openDurableHarness } from "../../src/agent/runtime/durable/harness.ts";
import { observeCompactionRequests } from "../../src/agent/runtime/durable/traceBridge.ts";

export type ScriptedResponse = {
  readonly events?: readonly AssistantMessageEvent[];
  readonly message: AssistantMessage;
};

export function createScriptedModels(
  handler: (
    model: Model<Api>,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => ScriptedResponse | Promise<ScriptedResponse>,
) {
  const models = createModels();
  const provider = createProvider({
    id: "stub",
    name: "Stub",
    auth: {
      apiKey: {
        name: "Stub key",
        resolve: async () => ({ auth: { apiKey: "stub-key" } }),
      },
    },
    models: [
      {
        id: "stub-model",
        api: "stub-api",
        name: "Stub Model",
        provider: "stub",
        baseUrl: "https://stub.invalid",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_000,
      },
    ],
    api: {
      stream: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        const abortNow = () => stream.end({ ...scriptedAbortedMessage(), timestamp: Date.now() });
        if (options?.signal?.aborted === true) abortNow();
        options?.signal?.addEventListener("abort", abortNow, { once: true });
        void Promise.resolve(handler(model, context, options)).then((response) => {
          for (const event of response.events ?? []) stream.push(event);
          stream.end(response.message);
        });
        return stream;
      },
      streamSimple: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        const abortNow = () => stream.end({ ...scriptedAbortedMessage(), timestamp: Date.now() });
        if (options?.signal?.aborted === true) abortNow();
        options?.signal?.addEventListener("abort", abortNow, { once: true });
        void Promise.resolve(handler(model, context, options)).then((response) => {
          for (const event of response.events ?? []) stream.push(event);
          stream.end(response.message);
        });
        return stream;
      },
    },
  });
  models.setProvider(provider);
  return ((pinnedReturn: MutableModels) => pinnedReturn)(models);
}

export function scriptedText(text: string, stopReason = "stop") {
  return ((pinnedReturn: ScriptedResponse) => pinnedReturn)({
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "stub-api",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: stopReason as AssistantMessage["stopReason"],
      timestamp: Date.now(),
    },
  });
}

function scriptedAbortedMessage() {
  return ((pinnedReturn: AssistantMessage) => pinnedReturn)({
    role: "assistant",
    content: [],
    api: "stub-api",
    provider: "stub",
    model: "stub-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "aborted",
    timestamp: 0,
  });
}

export async function createDurableTestRuntime(params: {
  readonly models: MutableModels;
  readonly sqliteDir?: string;
  readonly settings?: HarnessSettings;
}) {
  const registry = createRegistry();
  const sharedHeadByConversation = new Map<ConversationId, string>();
  const telemetry = new InMemoryTelemetryContext();
  const tracedModels = observeCompactionRequests(params.models);
  let handle: Awaited<ReturnType<typeof openHandle>>;
  const runtimeExtension: Extension = createRuntimeExtension({
    sharedHeadByConversation,
    harness: () => handle.harness,
  });
  registry.install(runtimeExtension);
  const openHandle = async () =>
    params.sqliteDir
      ? await openDurableHarness({
          sqliteDir: params.sqliteDir,
          registry,
          models: () => tracedModels,
          env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
          telemetry,
          settings: { extensions: [runtimeExtension], ...params.settings },
        })
      : await (async () => {
          const storage = new MemoryStorage();
          const harness = await Harness.open(
            storage,
            {
              registry,
              models: () => tracedModels,
              env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
              telemetry,
              settings: { extensions: [runtimeExtension], ...params.settings },
            },
            BACKGROUND_CONTEXT,
          );
          return ((pinnedReturn: {
            harness: Harness;
            resume: () => void;
            closed: Promise<import("@earendil-works/pi-durable").SessionEnd>;
            storage: MemoryStorage;
          }) => pinnedReturn)({
            harness,
            resume: () => harness.resume(),
            closed: harness.closed,
            storage,
          });
        })();
  handle = await openHandle();
  handle.resume();
  return ((pinnedReturn: DurableRuntime) => pinnedReturn)({
    handle,
    registry,
    models: { models: params.models, credentials: new InMemoryCredentialStore() },
    telemetry,
    sharedHeadByConversation,
    codemodeExtension: runtimeExtension,
    runtimeExtension,
  });
}

import type { DatabaseSync } from "node:sqlite";
import { openSqliteAppState } from "../integration/db.ts";
import { immediate } from "../../src/state/db.ts";
import {
  claimDispatchableWorkRun,
  insertWorkRun,
  markAttemptRunning,
  workRunById,
  type ClaimedWorkRun,
  type WorkRunKind,
} from "../../src/state/workRuns.ts";
import { intentKeyFor } from "../../src/state/publish.ts";
import {
  createFeaturePublication,
  recordPublishStep,
  type FeaturePublication,
} from "../../src/state/featurePublication.ts";

export type ExecutorDurableHarness = {
  readonly db: DatabaseSync;
  readonly close: () => void;
  readonly runtime: () => Promise<DurableRuntime>;
};

export function openExecutorDurableHarness() {
  const app = openSqliteAppState();
  let runtime: Promise<DurableRuntime> | undefined;
  return ((pinnedReturn: ExecutorDurableHarness) => pinnedReturn)({
    db: app.db,
    close: app.close,
    runtime: () =>
      (runtime ??= createDurableTestRuntime({
        models: createScriptedModels(() => scriptedText("ok")),
      })),
  });
}

export function seedRunningWorkRun(
  db: DatabaseSync,
  params: {
    readonly workId?: string;
    readonly kind?: WorkRunKind;
    readonly prKey?: string;
    readonly laneEpoch?: number;
    readonly payload?: Record<string, unknown>;
    readonly now?: number;
  } = {},
) {
  const now = params.now ?? Date.now();
  const kind = params.kind ?? "triage";
  const prKey = params.prKey ?? "o/r#1";
  const laneEpoch = params.laneEpoch ?? 0;
  return ((pinnedReturn: ClaimedWorkRun) => pinnedReturn)(
    immediate(db, () => {
      db.prepare(
        `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, auto_review_epoch, description_epoch,
           verification_epoch, triage_epoch, updated_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_key) DO NOTHING`,
      ).run(prKey, now, laneEpoch, laneEpoch, laneEpoch, laneEpoch, now);
      insertWorkRun(db, {
        workId: params.workId ?? "wi",
        prKey,
        kind,
        laneEpoch,
        payloadJson: JSON.stringify({
          installationId: 42,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "head",
          ...params.payload,
        }),
        now,
      });
      const claim = claimDispatchableWorkRun(db, now, { kinds: [kind] });
      if (claim === undefined) throw new Error("seeded work run was not claimable");
      markAttemptRunning(db, {
        workId: claim.run.work_id,
        attemptNo: claim.attempt.attempt_no,
        conversationId: null,
        taskId: null,
        now,
      });
      return { ...claim, run: { ...claim.run, status: "running" as const } };
    }),
  );
}

export type RecordedPublishStep = {
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: string;
  readonly step: string;
  readonly detail?: Record<string, unknown>;
  readonly githubId?: unknown;
};

function withoutGithubId(detail: Record<string, unknown>) {
  const { githubId: _githubId, ...rest } = detail;
  return rest;
}

export function testPublication(
  db: DatabaseSync,
  params: {
    readonly workId?: string;
    readonly kind?: WorkRunKind;
    readonly prKey?: string;
    readonly onRecord?: (client: DatabaseSync, record: RecordedPublishStep) => unknown;
    readonly shutdownRequested?: () => boolean;
    readonly seed?: boolean;
    readonly payload?: Record<string, unknown>;
  } = {},
) {
  const workId = params.workId ?? "wi";
  const prKey = params.prKey ?? "o/r#1";
  if (params.seed !== false && workRunById(db, workId) === undefined)
    seedRunningWorkRun(db, {
      workId,
      prKey,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      ...(params.payload !== undefined ? { payload: params.payload } : {}),
    });
  const publication = createFeaturePublication({
    db,
    workId,
    prKey,
    laneEpoch:
      params.kind === "ask" || params.kind === "ack" || params.kind === "ci_projection" ? null : 0,
    shutdownRequested: params.shutdownRequested ?? (() => false),
  });
  return ((pinnedReturn: FeaturePublication) => pinnedReturn)({
    ...publication,
    record: (record) => {
      params.onRecord?.(db, {
        workItemId: record.workId ?? workId,
        resourceKey: record.prKey ?? prKey,
        reviewLens: record.lens,
        step: record.step,
        ...(record.detail !== undefined ? { detail: withoutGithubId(record.detail) } : {}),
        ...(record.detail?.githubId !== undefined ? { githubId: record.detail.githubId } : {}),
      });
      publication.record(record);
    },
  });
}

export function seedPublishStep(
  db: DatabaseSync,
  params: {
    readonly workId?: string;
    readonly prKey?: string;
    readonly lens: string;
    readonly step: string;
    readonly detail: Record<string, unknown>;
    readonly now?: number;
  },
) {
  recordPublishStep(db, {
    workId: params.workId ?? "wi",
    prKey: params.prKey ?? "o/r#1",
    lens: params.lens,
    step: params.step,
    detail: params.detail,
    ...(params.now !== undefined ? { now: params.now } : {}),
  });
}

export function publishIntentRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT operation_key, state, mutation_kind, identity_json, result_json FROM publish_intents`,
    )
    .all();
}

type LegacyIntentStatus = "pending" | "reconciled" | "outcome_unknown" | "failed";

function legacyStatus(state: string) {
  if (state === "reconciled")
    return ((pinnedReturn: LegacyIntentStatus) => pinnedReturn)("reconciled");
  if (state === "mutation_failed")
    return ((pinnedReturn: LegacyIntentStatus) => pinnedReturn)("failed");
  if (state.startsWith("outcome_unknown"))
    return ((pinnedReturn: LegacyIntentStatus) => pinnedReturn)("outcome_unknown");
  return ((pinnedReturn: LegacyIntentStatus) => pinnedReturn)("pending");
}

export function legacyIntentStore(db: DatabaseSync) {
  const row = (workId: string, operationKey: string) =>
    db
      .prepare(`SELECT * FROM publish_intents WHERE intent_key = ?`)
      .get(intentKeyFor(workId, operationKey)) as
      | {
          readonly state: string;
          readonly identity_json: string;
          readonly result_json: string | null;
          readonly mutation_kind: string;
        }
      | undefined;
  return {
    getOperationIntent: async (_client: unknown, workId: string, operationKey: string) => {
      const found = row(workId, operationKey);
      if (found === undefined) return null;
      const identity = JSON.parse(found.identity_json) as Record<string, unknown>;
      return {
        workItemId: workId,
        operationKey,
        mutationKind: found.mutation_kind,
        status: legacyStatus(found.state),
        state: found.state,
        detail: {
          ...identity,
          ...(found.result_json != null ? { __result: JSON.parse(found.result_json) } : {}),
        },
      };
    },
    persistOperationIntent: async (
      _client: unknown,
      intent: {
        readonly workItemId: string;
        readonly operationKey: string;
        readonly mutationKind: string;
        readonly detail?: Record<string, unknown>;
        readonly prKey?: string;
        readonly resourceTarget?: string;
      },
    ) => {
      const { __mutating, __result, ...identity } = intent.detail ?? {};
      db.prepare(
        `INSERT INTO publish_intents
          (intent_key, pr_key, work_id, resource_target, operation_key, state, mutation_kind, identity_json, result_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (intent_key) DO UPDATE SET state = excluded.state, identity_json = excluded.identity_json,
           result_json = excluded.result_json`,
      ).run(
        intentKeyFor(intent.workItemId, intent.operationKey),
        intent.prKey ?? "o/r#1",
        intent.workItemId,
        intent.resourceTarget ?? `legacy:${intent.operationKey}`,
        intent.operationKey,
        __mutating === true ? "mutating" : __result !== undefined ? "reconciled" : "reserved",
        intent.mutationKind,
        JSON.stringify(identity),
        __result === undefined ? null : JSON.stringify(__result),
        Date.now(),
      );
      return { status: "pending" as const };
    },
    reconcileOperationIntent: async (
      _client: unknown,
      intent: {
        readonly workItemId: string;
        readonly operationKey: string;
        readonly status: LegacyIntentStatus;
        readonly detail?: Record<string, unknown>;
      },
    ) => {
      const state =
        intent.status === "reconciled"
          ? "reconciled"
          : intent.status === "failed"
            ? "mutation_failed"
            : intent.status === "outcome_unknown"
              ? intent.detail?.unknownResolution === "terminal"
                ? "outcome_unknown_terminal"
                : "outcome_unknown_recoverable"
              : "reserved";
      const result = intent.detail?.__result;
      db.prepare(
        `UPDATE publish_intents SET state = ?, result_json = COALESCE(?, result_json) WHERE intent_key = ?`,
      ).run(
        state,
        result === undefined ? null : JSON.stringify(result),
        intentKeyFor(intent.workItemId, intent.operationKey),
      );
      return { status: intent.status };
    },
  };
}

import type { Config } from "../../src/settings/index.ts";
import type { PrSurface } from "../../src/github/prSurface.ts";
import type { EscalationPlan } from "../../src/agentWork/retryPolicy.ts";
import type { FeatureExecutionEnv } from "../../src/agentWork/executors/featureExecution.ts";
import { withPrRepositoryView } from "../../src/prWorkspace/prRepositoryView.ts";
import { createFeaturePiSession } from "../../src/agent/runtime/createFeatureSession.ts";

export function testFeatureEnv(
  db: DatabaseSync,
  params: {
    readonly item: AgentWorkItem;
    readonly cfg: Config;
    readonly prSurface: PrSurface;
    readonly headSha?: string;
    readonly signal?: AbortSignal;
    readonly escalation?: EscalationPlan;
    readonly attemptNo?: number;
    readonly publication?: FeaturePublication;
    readonly onRecord?: (client: DatabaseSync, record: RecordedPublishStep) => unknown;
    readonly shouldAbortPublish?: () => Promise<boolean>;
  },
) {
  const publication =
    params.publication ??
    testPublication(db, {
      workId: params.item.id,
      prKey: params.item.resourceKey,
      kind: params.item.type,
      ...(params.onRecord !== undefined ? { onRecord: params.onRecord } : {}),
    });
  const headSha = params.headSha ?? params.item.headSha;
  return ((pinnedReturn: FeatureExecutionEnv) => pinnedReturn)({
    db,
    cfg: params.cfg,
    publication,
    prSurface: params.prSurface,
    headSha,
    signal: params.signal ?? new AbortController().signal,
    attemptNo: params.attemptNo ?? 1,
    ...(params.escalation !== undefined ? { escalation: params.escalation } : {}),
    createSession: createFeaturePiSession,
    withRepositoryView: (options, run) =>
      withPrRepositoryView(
        {
          ...options,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha,
          gitCredentialAuth: () => params.prSurface.gitCredentialAuth(),
        },
        run,
      ),
    shouldAbortPublish: params.shouldAbortPublish ?? (async () => !publication.current()),
  });
}
