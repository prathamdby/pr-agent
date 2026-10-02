import { createWorkDefinitions } from "../src/agentWork/workDefinition.js";
import { openInstallationSurface } from "../src/agentWork/installationSurface.js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import {
  createDurableRuntime,
  runDurableWorkItem,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.js";
import { initAnalytics, shutdownAnalytics } from "../src/analytics/index.js";
import { AppError } from "../src/errors/appError.js";
import {
  makeAskWorkItem,
  makeDescriptionWorkItem,
  makeReviewWorkItem,
  makeTriageWorkItem,
  makeVerificationWorkItem,
} from "./helpers/agentWorkItems.js";
import type { WorkCompletion } from "../src/analytics/workCompleted.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { runFullPrDescription } from "../src/agent/description/descriptionRun.js";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import { closeOwnVerdict } from "../src/agentWork/closeOwnVerdict.js";
import { loadPrHeadCiState } from "../src/agentWork/prHeadCiState.js";

vi.mock("../src/agentWork/prHeadCiState.js", () => ({ loadPrHeadCiState: vi.fn() }));
vi.mock("../src/agentWork/reviewLightweightCompletion.js", () => ({
  tryLightweightAutoReviewCompletion: vi.fn(),
}));
vi.mock("../src/agentWork/closeOwnVerdict.js", () => ({
  closeOwnVerdict: vi.fn(),
  postOwnVerdictPending: vi.fn(),
}));
vi.mock("../src/agentWork/reviewCheckRun.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/reviewCheckRun.js")>()),
  ensureReviewCheckRunStarted: vi.fn(async () => null),
}));

vi.mock("../src/agent/description/descriptionRun.js", () => ({
  runFullPrDescription: vi.fn(),
}));
vi.mock("../src/prWorkspace/prRepositoryView.js", () => ({
  withPrRepositoryView: vi.fn(async (_params, run) => run({ agentCwd: "/tmp", workspace: {} })),
}));
import { makeTestConfig } from "./helpers/config.js";
import { coreOf } from "./helpers/executorDurableHarness.js";

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

vi.mock("../src/agentWork/repository.js", () => ({
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
  loadReviewExecutorPublishContext: vi.fn(),
  getSummaryCommentGithubId: vi.fn(async () => null),
}));

vi.mock("../src/agentWork/reviewReschedule.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/reviewReschedule.js")>();
  return {
    ...actual,
    cancelOrphanedStaleHeadReplacementOnTerminalFailure: vi.fn(),
    tryBuildStaleReviewRescheduleResult: vi.fn(),
  };
});

vi.mock("../src/github/appAuth.js", () => ({
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
}));

import * as repo from "../src/agentWork/repository.js";
import * as appAuth from "../src/github/appAuth.js";

let installationSurface = openInstallationSurface();

const cfg = makeTestConfig({
  piFallbackProvider: "anthropic",
  piFallbackModel: "claude-sonnet-4",
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
    vi.mocked(repo.markWorkPublishDegraded).mockResolvedValue(undefined);
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
    vi.mocked(loadPrHeadCiState).mockResolvedValue(null);
    vi.mocked(closeOwnVerdict).mockResolvedValue(undefined);
    vi.mocked(repo.loadReviewExecutorPublishContext).mockResolvedValue({
      publishState: { summaryPublished: false, inlineReviewIds: [], threadCallCount: 0 },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
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
      });
      const cleanupError = new Error("verdict cleanup failed");
      vi.mocked(closeOwnVerdict).mockImplementation(async () => {
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
                      ? "tool_call_error"
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

  it.each([0, 1, cfg.queueRetryLimit + 1])(
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
      code: "agent_work.failed",
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
      code: "verification.missing_submit",
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
});
