import { createFakePublishStore } from "../src/agentWork/fakePublishStore.ts";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.ts").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.ts", () => ({
  persistOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.persistOperationIntent>) =>
      publishStoreState.store.persistOperationIntent(...args),
  ),
  mergeOperationIntentDetail: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.mergeOperationIntentDetail>) =>
      publishStoreState.store.mergeOperationIntentDetail(...args),
  ),
  reconcileOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.reconcileOperationIntent>) =>
      publishStoreState.store.reconcileOperationIntent(...args),
  ),
  getOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.getOperationIntent>) =>
      publishStoreState.store.getOperationIntent(...args),
  ),
  listPendingOperationIntents: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.listPendingOperationIntents>) =>
      publishStoreState.store.listPendingOperationIntents(...args),
  ),
  findInFlightMutatingIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.findInFlightMutatingIntent>) =>
      publishStoreState.store.findInFlightMutatingIntent(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
});
vi.mock("../src/agentWork/reconcilePendingIntents.ts", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { createWorkDefinitions } from "../src/agentWork/workDefinition.ts";
import { openInstallationSurface } from "../src/agentWork/installationSurface.ts";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import {
  createDurableRuntime,
  runDurableWorkItem,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.ts";
import { initAnalytics, shutdownAnalytics } from "../src/analytics/index.ts";
import { AppError } from "../src/errors/appError.ts";
import {
  makeAskWorkItem,
  makeDescriptionWorkItem,
  makeReviewWorkItem,
  makeTriageWorkItem,
  makeVerificationWorkItem,
} from "./helpers/agentWorkItems.ts";
import type { WorkCompletion } from "../src/analytics/workCompleted.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import { runFullPrDescription } from "../src/agent/description/descriptionRun.ts";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.ts";
import { loadPrHeadCiState } from "../src/agentWork/prHeadCiState.ts";

vi.mock("../src/agentWork/prHeadCiState.ts", () => ({ loadPrHeadCiState: vi.fn() }));
vi.mock("../src/agentWork/reviewLightweightCompletion.ts", () => ({
  tryLightweightAutoReviewCompletion: vi.fn(),
}));
const verdict = vi.hoisted(() => ({
  pending: vi.fn(async (): Promise<number | null> => null),
  close: vi.fn(async (_outcome: unknown): Promise<void> => undefined),
  repairIfOpen: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("../src/agentWork/reviewVerdict.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/reviewVerdict.ts")>()),
  reviewVerdict: vi.fn(() => verdict),
}));

vi.mock("../src/agent/description/descriptionRun.ts", () => ({
  runFullPrDescription: vi.fn(),
}));
vi.mock("../src/prWorkspace/prRepositoryView.ts", () => ({
  withPrRepositoryView: vi.fn(async (_params, run) => run({ agentCwd: "/tmp", workspace: {} })),
}));
vi.mock("../src/prWorkspace/localPrWorkspace.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prWorkspace/localPrWorkspace.ts")>()),
  workspaceCheckoutTelemetryFromError: vi.fn(() => undefined),
}));
import { makeTestConfig } from "./helpers/config.ts";
import { coreOf } from "./helpers/executorDurableHarness.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";
import { withPrRepositoryView } from "../src/prWorkspace/prRepositoryView.ts";
import { workspaceCheckoutTelemetryFromError } from "../src/prWorkspace/localPrWorkspace.ts";
import type {
  WorkspaceCheckoutTelemetry,
  WorkspaceFetchAttempt,
} from "../src/prWorkspace/checkoutTelemetry.ts";
import { initTraces } from "../src/traces/recorder.ts";
import { isRecord } from "../src/util/typeGuards.ts";

type PostHogOptions = {
  readonly host?: string;
  readonly enableExceptionAutocapture?: boolean;
  readonly before_send?: (event: unknown) => unknown;
};

const mockPostHog = vi.hoisted(() => {
  const instances: Array<{
    readonly capture: Mock;
    readonly captureException: Mock;
    readonly shutdown: Mock;
  }> = [];

  return {
    instances,
    PostHog: vi.fn(function MockPostHog(_apiKey: string, _options: PostHogOptions) {
      const capture = vi.fn();
      const captureException = vi.fn();
      const shutdown = vi.fn(async () => undefined);
      instances.push({ capture, captureException, shutdown });
      return { capture, captureException, shutdown };
    }),
  };
});

vi.mock("posthog-node", () => ({ PostHog: mockPostHog.PostHog }));
vi.mock("../src/agentWork/prActorLease.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/prActorLease.ts")>()),
  acquirePrActorLease: vi.fn(async () => ({ acquired: true, leaseEpoch: 1 })),
  isPrActorLeaseHeld: vi.fn(async () => true),
  releasePrActorLease: vi.fn(async () => undefined),
  armLeaseWatchdogHop: vi.fn(async () => ({ liveHop: true })),
}));

vi.mock("../src/agentWork/publishRecordRepository.ts", () => ({
  loadReviewExecutorPublishContext: vi.fn(),
  getSummaryCommentGithubId: vi.fn(async () => null),
}));

vi.mock("../src/agentWork/workItemStateRepository.ts", () => ({
  getWorkItem: vi.fn(),
  getWorkItemCore: vi.fn(),
  getWorkItemPayload: vi.fn(),
  shouldSkipWork: vi.fn(),
  markWorkCancelled: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
  claimWorkForExecution: vi.fn(),
  beginWorkAttempt: vi.fn(),
  markWorkCompleted: vi.fn(),
  forceMarkRescheduledParentCompleted: vi.fn(),
  markWorkFailed: vi.fn(),
  markWorkPublishDegraded: vi.fn(),
  markWorkRetrying: vi.fn(),
  updateRunningWorkHeadSha: vi.fn(),
}));

vi.mock("../src/agentWork/reviewReschedule.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/reviewReschedule.ts")>();
  return {
    ...actual,
    cancelOrphanedStaleHeadReplacementOnTerminalFailure: vi.fn(),
    tryBuildStaleReviewRescheduleResult: vi.fn(),
  };
});

vi.mock("../src/github/appAuth.ts", async (importOriginal) => ({
  parseRepositoryInstallation: (await importOriginal<typeof import("../src/github/appAuth.ts")>())
    .parseRepositoryInstallation,
  installationOctokit: vi.fn(() => {
    throw new Error("Unexpected live GitHub access in analytics fixture");
  }),
  mintInstallationAuth: vi.fn(),
  mintScopedInstallationAuth: vi.fn(
    (config: Parameters<typeof appAuth.mintInstallationAuth>[0], installationId: number) =>
      appAuth.mintInstallationAuth(config, installationId),
  ),
  getAppBotIdentity: vi.fn(),
  lookupRepositoryInstallation: vi.fn(async () => ({
    id: 99,
    app_id: 1,
    suspended_at: null,
    repository_selection: "all",
    permissions: {
      pull_requests: "write",
      contents: "read",
      issues: "write",
      checks: "write",
      statuses: "write",
      actions: "read",
    },
  })),
}));
vi.mock("../src/agentWork/githubCapabilityRepository.ts", () => ({
  nextGithubCapabilityObservationGeneration: vi.fn(async () => "1"),
  recordGithubCapabilityDenial: vi.fn(async () => true),
  saveGithubCapabilityObservation: vi.fn(async () => true),
  changeGithubPreflightFailureCount: vi.fn(async () => 0),
}));
vi.mock("../src/github/sharedRateLimitCircuit.ts", () => ({
  getSharedRateLimitCircuit: vi.fn(async () => null),
}));

import * as repo from "../src/agentWork/workItemStateRepository.ts";
import * as publishRecords from "../src/agentWork/publishRecordRepository.ts";
import * as appAuth from "../src/github/appAuth.ts";
import { isPrActorLeaseHeld } from "../src/agentWork/prActorLease.ts";

let installationSurface = openInstallationSurface();

const cfg = makeTestConfig({
  models: { fallbackProvider: "anthropic", fallbackModel: "claude-sonnet-4" },
});
const pool = {} as Pool;
const boss = {} as PgBoss;

function reviewJob(
  workItemId: string,
  retryCount: number,
  retryLimit: number,
): JobWithMetadata<{ workItemId: string }> {
  return {
    id: `job-${workItemId}`,
    data: { workItemId },
    retryCount,
    retryLimit,
    signal: new AbortController().signal,
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}

describe("durableJob analytics forwarding", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
    await initAnalytics({ projectToken: "token", host: "" });

    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      attemptCount: 1,
      resumed: false,
    });
    vi.mocked(repo.beginWorkAttempt).mockResolvedValue({
      kind: "started",
      claim: {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 1,
      },
    });
    vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
    vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(true);
    vi.mocked(repo.markWorkCancelled).mockResolvedValue(false);
    vi.mocked(isPrActorLeaseHeld).mockResolvedValue(true);
    vi.mocked(repo.markWorkPublishDegraded).mockResolvedValue(undefined);
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
    vi.mocked(loadPrHeadCiState).mockResolvedValue(null);
    verdict.close.mockReset().mockResolvedValue(undefined);
    vi.mocked(publishRecords.loadReviewExecutorPublishContext).mockResolvedValue({
      publishState: { summaryPublished: false, inlineReviewIds: [], threadCallCount: 0 },
      shouldLinkToSummary: false,
      resumedPlacements: [],
      progressCommentGithubId: null,
    });
    vi.mocked(appAuth.mintInstallationAuth).mockResolvedValue({
      type: "token",
      tokenType: "installation",
      token: "tok",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      installationId: 99,
    } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
    installationSurface = openInstallationSurface();
    vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
      userId: 999,
      login: "pr-agent[bot]",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownAnalytics();
  });

  it.each([
    { leaseMode: "unleased", changed: true },
    { leaseMode: "unleased", changed: false },
    { leaseMode: "leased", changed: true },
    { leaseMode: "leased", changed: false },
  ] as const)(
    "gates terminal cancellation on acknowledgement ($leaseMode, $changed)",
    async ({ leaseMode, changed }) => {
      const item = makeReviewWorkItem({ installationId: 99 });
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      const capture = mockPostHog.instances[0]?.capture;
      let acknowledge: (changed: boolean) => void = () => {
        throw new Error("cancellation has not reached its writer");
      };
      vi.mocked(repo.markWorkCancelled).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            acknowledge = resolve;
          }),
      );
      let executing = false;
      vi.mocked(repo.shouldSkipWork).mockImplementation(
        async () => leaseMode === "unleased" || executing,
      );
      const dispatch = runDurableWorkItem({
        type: "review",
        cfg,
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        runtime: createDurableRuntime({
          installationSurface,
          transaction: vi.fn().mockImplementation(async (_pool, fn) => fn(pool)),
          startLeaseRenewal: vi.fn(() => () => undefined),
          startCancelObserve: vi.fn(() => () => undefined),
        }),
        ...(leaseMode === "leased" ? { prActorLease: { queue: "agent-work-review" } } : {}),
        contextPolicy: { commenterId: () => undefined },
        resolveHeadSha: async () => ({ headSha: item.headSha }),
        execute: async () => {
          executing = true;
          return { kind: "completed" };
        },
      });
      await expect.poll(() => vi.mocked(repo.markWorkCancelled).mock.calls.length).toBe(1);
      expect(capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "work item cancelled" }),
      );
      acknowledge(changed);
      await dispatch;
      const terminals = capture?.mock.calls.filter(
        ([event]) => event.event === "work item cancelled",
      );
      expect(terminals).toHaveLength(changed ? 1 : 0);
      if (changed) {
        expect(terminals?.[0]?.[0]).toMatchObject({
          properties: { work_item_id: item.id, source: "worker", outcome: "cancelled" },
        });
      }
      expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    },
  );

  it("does not infer terminal cancellation after lease ownership is lost", async () => {
    const item = makeReviewWorkItem({ installationId: 99 });
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
    let executing = false;
    vi.mocked(isPrActorLeaseHeld).mockImplementation(async () => !executing);
    vi.mocked(repo.shouldSkipWork).mockImplementation(async () => executing);
    vi.mocked(repo.markWorkCancelled).mockResolvedValue(true);
    await runDurableWorkItem({
      type: "review",
      cfg,
      pool,
      boss,
      job: reviewJob(item.id, 0, 3),
      prActorLease: { queue: "agent-work-review" },
      runtime: createDurableRuntime({
        installationSurface,
        transaction: vi.fn().mockImplementation(async (_pool, fn) => fn(pool)),
        startLeaseRenewal: vi.fn(() => () => undefined),
        startCancelObserve: vi.fn(() => () => undefined),
      }),
      contextPolicy: { commenterId: () => undefined },
      resolveHeadSha: async () => ({ headSha: item.headSha }),
      execute: async () => {
        executing = true;
        return { kind: "completed" };
      },
    });
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(mockPostHog.instances[0]?.capture).toHaveBeenCalledTimes(1);
    expect(mockPostHog.instances[0]?.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work execution stopped",
        properties: expect.objectContaining({ reason: "lease_lost" }),
      }),
    );
  });

  it.each([
    makeReviewWorkItem,
    makeAskWorkItem,
    makeDescriptionWorkItem,
    makeTriageWorkItem,
    makeVerificationWorkItem,
  ])("reports an aborted execution without inventing a terminal completion", async (makeItem) => {
    const item = makeItem({ installationId: 99 });
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
    const abort = new AbortController();
    const job = { ...reviewJob(item.id, 0, 3), signal: abort.signal };
    await runDurableWorkItem({
      type: item.type,
      cfg,
      pool,
      boss,
      job,
      runtime: createDurableRuntime({ installationSurface }),
      contextPolicy: { commenterId: () => undefined },
      resolveHeadSha: async () => ({ headSha: item.headSha }),
      execute: async (_item, execution) => {
        await execution.beginAttempt();
        abort.abort();
        throw new AppError({
          domain: "agent",
          kind: "session_aborted",
          message: "Aborted",
        });
      },
    });
    const capture = mockPostHog.instances[0]?.capture;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work execution stopped",
        properties: expect.objectContaining({
          work_item_id: item.id,
          work_type: item.type,
          reason: "job_aborted",
          execution_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          attempt_count: 1,
        }),
      }),
    );
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
  });

  it.each(["won", "lost", "cleanup_throw"] as const)(
    "keeps the real lightweight review profiling interval but gates capture (%s)",
    async (resolution) => {
      const item = makeReviewWorkItem({ installationId: 99, source: "auto", headSha: "head" });
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      const started = new Date("2026-01-01T00:00:05Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(started + 17);
      vi.mocked(tryLightweightAutoReviewCompletion).mockResolvedValue({
        handled: true,
        published: true,
        summaryId: 42,
        check: { conclusion: "success", blockingCount: 0 },
      });
      const cleanupError = new Error("verdict cleanup failed");
      verdict.close.mockImplementation(async () => {
        vi.mocked(Date.now).mockReturnValue(started + 5_000);
        if (resolution === "cleanup_throw") throw cleanupError;
      });
      vi.mocked(repo.markWorkCompleted).mockImplementation(async () => {
        expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalled();
        vi.mocked(Date.now).mockReturnValue(started + 7_000);
        return resolution === "won";
      });
      const definitions = createWorkDefinitions({ cfg, pool, boss });
      const dispatch = runDurableWorkItem({
        type: "review",
        cfg,
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        runtime: createDurableRuntime({
          installationSurface: {
            ...installationSurface,
            create: async () => createFakePrSurface(item, { headSha: "head" }).surface,
          },
        }),
        contextPolicy: definitions.review.contextPolicy,
        resolveHeadSha: async () => ({ headSha: "head" }),
        execute: definitions.review.execute,
      });
      if (resolution === "cleanup_throw") await expect(dispatch).rejects.toBe(cleanupError);
      else await expect(dispatch).resolves.toBeUndefined();
      expect(tryLightweightAutoReviewCompletion).toHaveBeenCalledTimes(1);
      if (resolution === "won") {
        expect(mockPostHog.instances[0]?.capture).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "work completed",
            properties: expect.objectContaining({
              outcome: "lightweight",
              source: "auto",
              duration_ms: 17,
              publish_attempts: 0,
              publish_step_count: 0,
            }),
          }),
        );
      } else {
        expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalledWith(
          expect.objectContaining({ event: "work completed" }),
        );
      }
    },
  );

  it.each(["won", "lost", "cancelled", "rejected"] as const)(
    "B2 captures real description completion only after the winning mark (%s)",
    async (resolution) => {
      const item = makeDescriptionWorkItem({ installationId: 99 });
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      let executed = false;
      vi.mocked(runFullPrDescription).mockImplementation(async () => {
        executed = true;
        return {
          published: true,
          publishSuperseded: false,
          lastAssistant: {
            role: "assistant",
            content: [],
            stopReason: "stop",
            api: "openai-completions",
            provider: "openai",
            model: "test",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        };
      });
      vi.mocked(repo.shouldSkipWork).mockImplementation(
        async () => resolution === "cancelled" && executed,
      );
      const capture = mockPostHog.instances[0]?.capture;
      const rejected = new Error("completion mark rejected");
      vi.mocked(repo.markWorkCompleted).mockImplementation(async () => {
        expect(capture).not.toHaveBeenCalled();
        if (resolution === "rejected") throw rejected;
        return resolution === "won";
      });
      const runtime = createDurableRuntime({
        installationSurface: {
          ...installationSurface,
          create: async () => createFakePrSurface(item).surface,
        },
      });
      const definition = createWorkDefinitions({ cfg, pool, boss });
      const dispatch = runDurableWorkItem({
        type: "description",
        cfg,
        pool,
        boss,
        runtime,
        job: reviewJob(item.id, 0, 3),
        contextPolicy: definition.description.contextPolicy,
        resolveHeadSha: async () => ({ headSha: item.headSha }),
        execute: definition.description.execute,
      });
      if (resolution === "rejected") await expect(dispatch).rejects.toBe(rejected);
      else await expect(dispatch).resolves.toBeUndefined();
      expect(runFullPrDescription).toHaveBeenCalledTimes(1);
      if (resolution === "won") {
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "work completed",
            properties: expect.objectContaining({
              work_type: "description",
              outcome: "published",
              source: item.payload.source,
            }),
          }),
        );
      } else {
        expect(capture).not.toHaveBeenCalledWith(
          expect.objectContaining({ event: "work completed" }),
        );
      }
    },
  );

  it.each([
    { kind: "ask", outcome: "published", replyTargetKind: "prConversation" },
    {
      kind: "ask",
      outcome: "degraded",
      replyTargetKind: "prConversation",
      durableDegradation: "reply_outcome_unknown",
    },
    { kind: "triage", outcome: "published", scope: "thread" },
    {
      kind: "verification",
      outcome: "degraded",
      inventoryNarrowed: true,
      durableDegradation: "inventory_narrowed",
    },
    {
      kind: "review-profile",
      outcome: "lightweight",
      reviewLens: "review",
      source: "auto",
      provider: "openai",
      model: "test",
      durationMs: 17,
      attemptCount: 0,
      publish: { publishAttempts: 0, publishStepCount: 0 },
    },
    {
      kind: "review-profile",
      outcome: "failed",
      reviewLens: "review",
      source: "slash",
      provider: "openai",
      model: "test",
      durationMs: 23,
      attemptCount: 1,
      publish: { publishAttempts: 2, publishStepCount: 0 },
      failure: {
        failureDomain: "provider",
        errorKind: "quota",
        providerErrorKind: "quota",
        phase: "synthesis",
        errorMessage: "Insufficient credits for model",
      },
    },
    {
      kind: "review-profile",
      outcome: "published",
      reviewLens: "review",
      source: "slash",
      provider: "openai",
      model: "test",
      durationMs: 29,
      attemptCount: 1,
      findingsCount: 2,
      specialistReport: 2,
      specialistEmpty: 1,
      specialistError: 1,
      publish: { publishAttempts: 0, publishStepCount: 5 },
    },
    {
      kind: "review-profile",
      outcome: "degraded",
      degradedReason: "tool_call_error",
      reviewLens: "review",
      source: "slash",
      provider: "openai",
      model: "test",
      durationMs: 31,
      attemptCount: 1,
      findingsCount: 1,
      publish: { publishAttempts: 0, publishStepCount: 5 },
    },
    {
      kind: "review-profile",
      outcome: "degraded",
      degradedReason: "judgment_degraded",
      reviewLens: "review",
      source: "slash",
      provider: "openai",
      model: "test",
      durationMs: 32,
      attemptCount: 1,
      findingsCount: 0,
      publish: { publishAttempts: 0, publishStepCount: 5 },
    },
  ] satisfies WorkCompletion[])(
    "renders a closed $kind completion after the mark ($outcome)",
    async (completion) => {
      const item =
        completion.kind === "ask"
          ? makeAskWorkItem({ installationId: 99 })
          : completion.kind === "triage"
            ? makeTriageWorkItem({ installationId: 99 })
            : completion.kind === "verification"
              ? makeVerificationWorkItem({ installationId: 99 })
              : makeReviewWorkItem({ installationId: 99 });
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      await runDurableWorkItem({
        type: item.type,
        cfg,
        pool,
        boss,
        runtime: createDurableRuntime({ installationSurface }),
        job: reviewJob(item.id, 0, 3),
        contextPolicy: { commenterId: () => undefined },
        resolveHeadSha: async () => ({ headSha: item.headSha }),
        execute: vi.fn().mockResolvedValue({ kind: "completed", completion }),
      });
      const capture = mockPostHog.instances[0]?.capture;
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "work completed",
          properties: expect.objectContaining({
            outcome: completion.outcome,
            work_type: item.type,
            work_item_id: item.id,
            owner: item.owner,
            repo: item.repo,
            pr_number: item.prNumber,
            head_sha: item.headSha,
            ci_rollup: "none",
            ci_failing_count: 0,
            ci_authored: false,
            ...(completion.kind === "review-profile"
              ? {
                  duration_ms: completion.durationMs,
                  attempt_count: completion.attemptCount,
                  publish_attempts: completion.publish.publishAttempts,
                  publish_step_count: completion.publish.publishStepCount,
                  review_lens: "review",
                  provider: "openai",
                  model: "test",
                  source: completion.source,
                }
              : {}),
            ...(completion.kind === "ask" ? { reply_target_kind: "prConversation" } : {}),
            ...(completion.kind === "triage" ? { scope: "thread" } : {}),
            ...(completion.kind === "verification" ? { inventory_narrowed: true } : {}),
            ...(completion.outcome === "degraded"
              ? {
                  degraded_reason:
                    completion.kind === "review-profile"
                      ? completion.degradedReason
                      : "durable_degradation",
                  ...(completion.kind !== "review-profile"
                    ? { durable_degradation: completion.durableDegradation }
                    : {}),
                }
              : {}),
            ...(completion.kind === "review-profile" && completion.outcome === "failed"
              ? {
                  failure_domain: "provider",
                  error_kind: "quota",
                  provider_error_kind: "quota",
                  phase: "synthesis",
                  error_message: "Insufficient credits for model",
                }
              : {}),
            ...(completion.kind === "review-profile" && completion.outcome === "published"
              ? {
                  findings_count: 2,
                  specialist_report: 2,
                  specialist_empty: 1,
                  specialist_error: 1,
                }
              : {}),
          }),
        }),
      );
      const properties = capture?.mock.calls[0]?.[0].properties;
      expect(properties).not.toHaveProperty("cause_chain");
      expect(properties).not.toHaveProperty("provider_output_tokens");
      expect(properties).not.toHaveProperty("wall_clock_ms");
      expect(properties).not.toHaveProperty("generation_ms");
      expect(properties).not.toHaveProperty("provider_output_tps");
      expect(mockPostHog.instances[0]?.captureException).not.toHaveBeenCalled();
    },
  );

  it("downgrades a winning published review when CI remains incomplete", async () => {
    const item = makeReviewWorkItem({ installationId: 99 });
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
    vi.mocked(loadPrHeadCiState).mockResolvedValue({
      owner: item.owner,
      repo: item.repo,
      headSha: item.headSha,
      checks: {},
      rollup: "unknown",
      version: 1,
      authored: null,
      prNumbers: [],
      truncated: false,
      seededAt: null,
      projectionRepairPending: false,
      firstSeenAt: new Date(),
      updatedAt: new Date(),
    });
    await runDurableWorkItem({
      type: "review",
      cfg,
      pool,
      boss,
      runtime: createDurableRuntime({ installationSurface }),
      job: reviewJob(item.id, 0, 3),
      contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
      resolveHeadSha: async () => ({ headSha: item.headSha }),
      execute: vi.fn().mockResolvedValue({
        kind: "completed",
        completion: {
          kind: "review-profile",
          outcome: "published",
          reviewLens: "review",
          source: "slash",
          provider: "openai",
          model: "test",
          durationMs: 12,
          attemptCount: 1,
          publish: { publishAttempts: 0, publishStepCount: 5 },
        },
      }),
    });
    expect(mockPostHog.instances[0]?.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          outcome: "degraded",
          degraded_reason: "ci_unavailable",
          ci_rollup: "unknown",
          ci_unavailable_reason: "incomplete",
        }),
      }),
    );
  });

  it.each([0, 1, cfg.queue.retryLimit + 1])(
    "#657 keeps pre-admission infrastructure retries out of work retry analytics (%i)",
    async (attemptCount) => {
      const item = makeReviewWorkItem({ id: "wi-preparation", installationId: 99 });
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      vi.mocked(repo.claimWorkForExecution).mockResolvedValue({
        createdAt: new Date(),
        startedAt: new Date(),
        attemptCount,
        resumed: attemptCount > 0,
      });
      const failure = new Error("synthetic head preparation failure");
      const execute = vi.fn();
      await expect(
        runDurableWorkItem({
          contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
          cfg,
          runtime: createDurableRuntime({ installationSurface }),
          pool,
          boss,
          type: "review",
          job: reviewJob(item.id, 0, 3),
          resolveHeadSha: async () => {
            throw failure;
          },
          execute,
        }),
      ).rejects.toBe(failure);
      expect(execute).not.toHaveBeenCalled();
      expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, item.id, failure, null);
      expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "work item retried" }),
      );
      expect(repo.markWorkFailed).not.toHaveBeenCalled();
    },
  );

  it("emits work completed on terminal failure without $exception", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-1",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const boom = new Error("enqueue failed");
    const execute = vi.fn().mockRejectedValue(boom);
    const job = {
      id: "job-1",
      data: { workItemId: item.id },
      retryCount: 3,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobWithMetadata<{ workItemId: string }>;

    const spec: DurableJobSpec<"review"> = {
      contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
      type: "review",
      cfg,
      runtime: createDurableRuntime({ installationSurface }),
      pool,
      boss,
      job,
      resolveHeadSha: async () => ({ headSha: "abc123" }),
      execute: async (item, env) => {
        await env.beginAttempt();
        return execute(item, env);
      },
    };

    await expect(runDurableWorkItem(spec)).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, null);
    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work completed",
      properties: expect.objectContaining({
        work_type: "review",
        outcome: "failed",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        failure_domain: expect.any(String),
        error_kind: expect.any(String),
        error_message: "enqueue failed",
      }),
    });
    expect(client?.capture).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "work item retried" }),
    );
    expect(client?.captureException).not.toHaveBeenCalled();
    const properties = client?.capture.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "work completed",
    )?.[0] as { properties: Record<string, unknown> };
    expect(properties.properties).not.toHaveProperty("cause_chain");
    expect(properties.properties).not.toHaveProperty("http_status");
    expect(properties.properties).not.toHaveProperty("request_path");
  });

  it("classifies provider credit failures on work completed", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-quota",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const boom = new Error("Insufficient credits for model");
    const execute = vi.fn().mockRejectedValue(boom);
    const job = {
      id: "job-quota",
      data: { workItemId: item.id },
      retryCount: 3,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobWithMetadata<{ workItemId: string }>;

    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job,
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (item, env) => {
          await env.beginAttempt();
          return execute(item, env);
        },
      }),
    ).resolves.toBeUndefined();

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work completed",
      properties: expect.objectContaining({
        outcome: "failed",
        work_type: "review",
        failure_domain: "provider",
        error_kind: "quota",
        provider_error_kind: "quota",
        error_message: "Insufficient credits for model",
      }),
    });
    expect(client?.captureException).not.toHaveBeenCalled();
    const properties = client?.capture.mock.calls[0]?.[0] as {
      properties: Record<string, unknown>;
    };
    expect(properties.properties).not.toHaveProperty("cause_chain");
    expect(properties.properties).not.toHaveProperty("http_status");
    expect(properties.properties).not.toHaveProperty("request_path");
  });

  it("sanitizes AppError fields on terminal durable-job failures", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-secret",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const boom = new AppError({
      domain: "review",
      kind: "specialist_failed",
      message: `worker failed Bearer ${token}`,
      context: {
        workItemId: item.id,
        rawValue: { database: "postgres://user:pass@db/app" },
      },
      cause: new Error("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"),
    });
    const job = {
      id: "job-secret",
      data: { workItemId: item.id },
      retryCount: 3,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobWithMetadata<{ workItemId: string }>;

    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job,
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (_item, env) => {
          await env.beginAttempt();
          throw boom;
        },
      }),
    ).resolves.toBeUndefined();

    const client = mockPostHog.instances[0];
    expect(client?.captureException).not.toHaveBeenCalled();
    const captured = client?.capture.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "work completed",
    )?.[0] as { properties: Record<string, unknown> };
    expect(captured).toBeDefined();
    const json = JSON.stringify(captured);
    expect(json).not.toContain(token);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(captured.properties).toHaveProperty("error_message");
    expect(String(captured.properties.error_message)).toContain("[redacted]");
    expect(captured.properties).not.toHaveProperty("cause_chain");
  });

  it("emits work item retried with the disposition and the next attempt's escalation kinds", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-retry",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const transient = new Error("transient");
    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (_item, env) => {
          await env.beginAttempt();
          throw transient;
        },
      }),
    ).rejects.toBe(transient);

    const deterministic = new AppError({
      domain: "verification",
      kind: "missing_submit",
      message: "Verification run ended without submitVerification",
    });
    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 1, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (_item, env) => {
          await env.beginAttempt();
          throw deterministic;
        },
      }),
    ).rejects.toBe(deterministic);

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work item retried",
      properties: expect.objectContaining({
        work_type: "review",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        attempt_count: 1,
        next_attempt: 2,
        retry_disposition: "transient",
        escalation_kinds: ["tool_rounds", "fallback_model"],
        failure_domain: expect.any(String),
        error_kind: expect.any(String),
        error_message: "transient",
      }),
    });
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work item retried",
      properties: expect.objectContaining({
        retry_disposition: "deterministic",
        escalation_kinds: ["tool_rounds", "fallback_model"],
      }),
    });
    expect(client?.capture).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({ outcome: "failed" }),
      }),
    );
  });

  it("forwards GitHub 403 status, path, and sanitized message on work item retried", async () => {
    const item = makeVerificationWorkItem({
      status: "running",
      id: "wi-github-403",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const forbidden = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
      request: { url: "https://api.github.com/repos/acme/widgets/check-runs" },
    });
    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).verification.contextPolicy,
        type: "verification",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (_item, env) => {
          await env.beginAttempt();
          throw forbidden;
        },
      }),
    ).rejects.toBe(forbidden);

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work item retried",
      properties: expect.objectContaining({
        work_type: "verification",
        failure_domain: "github",
        error_kind: "forbidden",
        retry_disposition: "transient",
        error_message: "Resource not accessible by integration",
        http_status: 403,
        request_path: "/repos/acme/widgets/check-runs",
      }),
    });
    const captured = client?.capture.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "work item retried",
    )?.[0] as { properties: Record<string, unknown> };
    expect(captured.properties).not.toHaveProperty("cause_chain");
  });

  it("forwards GitHub 403 status, path, and sanitized message on failed work completed", async () => {
    const item = makeVerificationWorkItem({
      status: "running",
      id: "wi-github-403-terminal",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    const forbidden = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
      request: { url: "https://api.github.com/repos/acme/widgets/check-runs" },
    });
    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).verification.contextPolicy,
        type: "verification",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 3, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: async (_item, env) => {
          await env.beginAttempt();
          throw forbidden;
        },
      }),
    ).resolves.toBeUndefined();

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work completed",
      properties: expect.objectContaining({
        work_type: "verification",
        outcome: "failed",
        failure_domain: "github",
        error_kind: "forbidden",
        error_message: "Resource not accessible by integration",
        http_status: 403,
        request_path: "/repos/acme/widgets/check-runs",
      }),
    });
    const captured = client?.capture.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "work completed",
    )?.[0] as { properties: Record<string, unknown> };
    expect(captured.properties).not.toHaveProperty("cause_chain");
  });

  it("does not emit a terminal PostHog event from the durable runner on degraded completion", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-degraded",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: vi.fn().mockResolvedValue({
          kind: "completed",
          degradation: ["stale_head", "thread_resolution_degraded"],
        }),
      }),
    ).resolves.toBeUndefined();

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, item.id, null);
    expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalled();
  });

  it("does not emit a terminal PostHog event for a clean completion", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-clean",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);

    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: vi.fn().mockResolvedValue({ kind: "completed" }),
      }),
    ).resolves.toBeUndefined();

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
    expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalled();
  });

  it("does not emit a terminal PostHog event when completion loses the race", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-raced",
      installationId: 99,
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
    });
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);

    await expect(
      runDurableWorkItem({
        contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
        type: "review",
        cfg,
        runtime: createDurableRuntime({ installationSurface }),
        pool,
        boss,
        job: reviewJob(item.id, 0, 3),
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: vi.fn().mockResolvedValue({
          kind: "completed",
          degradation: ["stale_head"],
        }),
      }),
    ).resolves.toBeUndefined();

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, item.id, null);
    expect(mockPostHog.instances[0]?.capture).not.toHaveBeenCalled();
  });

  describe("workspace checkout telemetry", () => {
    const sparseSucceeded: WorkspaceFetchAttempt = {
      checkoutMode: "sparse",
      outcome: "succeeded",
      errorCode: null,
      failureKind: null,
      timeoutSource: null,
      exitCode: 0,
      signal: null,
      killed: false,
      elapsedMs: 40,
      stderr: null,
    };
    const fallbackTelemetry: WorkspaceCheckoutTelemetry = {
      mode: "sparse_fallback",
      fallbackReason: "fetch_timeout",
      fetchAttempts: [
        {
          checkoutMode: "full",
          outcome: "failed",
          errorCode: "pr_workspace.fetch_timeout",
          failureKind: "timeout",
          timeoutSource: "process_timer",
          exitCode: null,
          signal: "SIGTERM",
          killed: true,
          elapsedMs: 1_500,
          stderr: "",
        },
        sparseSucceeded,
      ],
    };
    const fullTelemetry: WorkspaceCheckoutTelemetry = {
      mode: "full",
      fallbackReason: null,
      fetchAttempts: [{ ...sparseSucceeded, checkoutMode: "full" }],
    };
    let spans: Array<Record<string, unknown>>;
    let drainTraces: () => Promise<void>;

    beforeEach(() => {
      spans = [];
      drainTraces = initTraces(
        makeTestConfig({ runtime: { role: "worker" }, posthog: { projectToken: "phc" } }),
        {
          capture: (input) => spans.push(input.properties),
          flush: async () => undefined,
          shutdown: async () => undefined,
        },
      );
    });

    afterEach(async () => {
      await drainTraces();
    });

    function serveView(telemetry: WorkspaceCheckoutTelemetry, reused: boolean): void {
      vi.mocked(withPrRepositoryView).mockImplementation(async (_params, run) =>
        run({
          agentCwd: "/tmp/pr-agent",
          preflight: { files: [], truncated: false, fileCount: 0, totalChanges: 0 },
          workspace: { ...mockLocalPrWorkspace(), checkoutTelemetry: telemetry },
          reused,
        }),
      );
    }

    function dispatchAsk(
      item: ReturnType<typeof makeAskWorkItem>,
      execute: DurableJobSpec<"ask">["execute"],
    ): Promise<void> {
      vi.mocked(repo.getWorkItem).mockResolvedValue(item);
      vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
      vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item.payload);
      return runDurableWorkItem({
        type: "ask",
        cfg,
        pool,
        boss,
        runtime: createDurableRuntime({ installationSurface }),
        job: reviewJob(item.id, 0, 3),
        contextPolicy: { commenterId: () => undefined },
        resolveHeadSha: async () => ({ headSha: item.headSha }),
        execute,
      });
    }

    const askCompletion: WorkCompletion = {
      kind: "ask",
      outcome: "published",
      replyTargetKind: "prConversation",
    };

    async function executionSpan(): Promise<Record<string, unknown> | undefined> {
      await drainTraces();
      return spans.find((span) => span.$ai_span_name === "execution");
    }

    function capturedEvent(event: string): Record<string, unknown> | undefined {
      for (const [input] of mockPostHog.instances[0]?.capture.mock.calls ?? []) {
        if (isRecord(input) && input.event === event && isRecord(input.properties)) {
          return input.properties;
        }
      }
      return undefined;
    }

    it("annotates the execution span and work completed with a same-attempt sparse fallback", async () => {
      serveView(fallbackTelemetry, false);
      await dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) => {
        await env.withAdmittedRepositoryView({}, async () => undefined);
        return { kind: "completed", completion: askCompletion };
      });
      const expected = {
        workspace_checkout_mode: "sparse_fallback",
        workspace_fallback_reason: "fetch_timeout",
        workspace_checkout_reused: false,
        workspace_fetch_attempts: 2,
        git_operation: "fetch",
        git_checkout_mode: "sparse",
        git_exit_code: 0,
        git_killed: false,
        fallback_git_error_code: "pr_workspace.fetch_timeout",
        fallback_git_error_kind: "timeout",
        fallback_git_signal: "SIGTERM",
        fallback_git_killed: true,
        fallback_git_timeout_source: "process_timer",
      };
      expect(capturedEvent("work completed")).toMatchObject({ outcome: "published", ...expected });
      const span = await executionSpan();
      expect(span).toMatchObject({ status: "ok", ...expected });
      expect(span).not.toHaveProperty("$ai_error");
    });

    it("marks a cached workspace view as reused", async () => {
      serveView(fullTelemetry, true);
      await dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) => {
        await env.withAdmittedRepositoryView({}, async () => undefined);
        return { kind: "completed", completion: askCompletion };
      });
      const properties = capturedEvent("work completed");
      expect(properties).toMatchObject({
        workspace_checkout_mode: "full",
        workspace_fallback_reason: null,
        workspace_checkout_reused: true,
        git_exit_code: 0,
      });
      expect(properties).not.toHaveProperty("fallback_git_error_code");
      expect(await executionSpan()).toMatchObject({ workspace_checkout_reused: true });
    });

    it("reports a terminal checkout failure on the span and the failed completion", async () => {
      const failure = new AppError({
        domain: "pr_workspace",
        kind: "git_failed",
        message: "git fetch failed with exit code 128 (auth)",
        context: { operation: "fetch", failureKind: "auth", exitCode: 128 },
      });
      vi.mocked(workspaceCheckoutTelemetryFromError).mockImplementation((error) =>
        error === failure
          ? {
              mode: "full",
              fallbackReason: null,
              fetchAttempts: [
                {
                  checkoutMode: "full",
                  outcome: "failed",
                  errorCode: "pr_workspace.git_failed",
                  failureKind: "auth",
                  timeoutSource: null,
                  exitCode: 128,
                  signal: null,
                  killed: false,
                  elapsedMs: 30,
                  stderr: "fatal: Authentication failed",
                },
              ],
            }
          : undefined,
      );
      vi.mocked(withPrRepositoryView).mockRejectedValue(failure);
      await expect(
        dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) =>
          env.withAdmittedRepositoryView({}, async () => ({ kind: "completed" as const })),
        ),
      ).resolves.toBeUndefined();
      expect(repo.markWorkFailed).toHaveBeenCalled();
      expect(repo.markWorkRetrying).not.toHaveBeenCalled();
      const properties = capturedEvent("work completed");
      expect(properties).toMatchObject({
        outcome: "failed",
        failure_domain: "internal",
        error_kind: "auth",
        workspace_checkout_mode: "full",
        git_error_code: "pr_workspace.git_failed",
        git_error_kind: "auth",
        git_exit_code: 128,
      });
      expect(JSON.stringify(properties)).not.toContain("Authentication failed");
      expect(await executionSpan()).toMatchObject({
        status: "error",
        $ai_is_error: true,
        $ai_error: {
          code: "pr_workspace.git_failed",
          message: "git fetch failed with exit code 128 (auth)",
        },
        git_error_kind: "auth",
      });
    });

    it("carries checkout telemetry on the retry envelope", async () => {
      const failure = new AppError({
        domain: "pr_workspace",
        kind: "git_failed",
        message: "git fetch failed with exit code 128",
        context: { operation: "fetch", failureKind: "git", exitCode: 128 },
      });
      serveView(fallbackTelemetry, false);
      await expect(
        dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) =>
          env.withAdmittedRepositoryView({}, async () => {
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      expect(capturedEvent("work item retried")).toMatchObject({
        retry_disposition: "transient",
        error_kind: "git",
        workspace_checkout_mode: "sparse_fallback",
        fallback_git_error_code: "pr_workspace.fetch_timeout",
      });
      expect(capturedEvent("work completed")).toBeUndefined();
    });

    it("keeps span annotations but skips work completed when the completion mark loses", async () => {
      vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
      serveView(fallbackTelemetry, false);
      await dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) => {
        await env.withAdmittedRepositoryView({}, async () => undefined);
        return { kind: "completed", completion: askCompletion };
      });
      expect(capturedEvent("work completed")).toBeUndefined();
      expect(await executionSpan()).toMatchObject({ workspace_checkout_mode: "sparse_fallback" });
    });

    it("finishes the work when analytics and trace sinks throw", async () => {
      await drainTraces();
      drainTraces = initTraces(
        makeTestConfig({ runtime: { role: "worker" }, posthog: { projectToken: "phc" } }),
        {
          capture: () => {
            throw new Error("trace sink down");
          },
          flush: async () => undefined,
          shutdown: async () => undefined,
        },
      );
      mockPostHog.instances[0]?.capture.mockImplementation(() => {
        throw new Error("analytics sink down");
      });
      serveView(fallbackTelemetry, false);
      await expect(
        dispatchAsk(makeAskWorkItem({ installationId: 99 }), async (_item, env) => {
          await env.withAdmittedRepositoryView({}, async () => undefined);
          return { kind: "completed", completion: askCompletion };
        }),
      ).resolves.toBeUndefined();
      expect(repo.markWorkCompleted).toHaveBeenCalled();
      await drainTraces();
    });
  });
});
