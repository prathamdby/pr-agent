import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import {
  clearDurableAuthCachesForTest,
  runDurableWorkItem,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.js";
import { initAnalytics, shutdownAnalytics } from "../src/analytics/index.js";
import { AppError } from "../src/errors/appError.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";
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
  markWorkCompleted: vi.fn(),
  forceMarkRescheduledParentCompleted: vi.fn(),
  markWorkFailed: vi.fn(),
  markWorkPublishDegraded: vi.fn(),
  markWorkRetrying: vi.fn(),
  updateRunningWorkHeadSha: vi.fn(),
}));

vi.mock("../src/agentWork/reviewReschedule.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/reviewReschedule.js")>();
  return {
    ...actual,
    cancelOrphanedStaleHeadReplacementOnTerminalFailure: vi.fn(),
  };
});

vi.mock("../src/github/appAuth.js", () => ({
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
}));

import * as repo from "../src/agentWork/repository.js";
import * as appAuth from "../src/github/appAuth.js";

const cfg = {} as Config;
const pool = {} as Pool;
const boss = {} as PgBoss;

describe("durableJob analytics forwarding", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
    await initAnalytics({ projectToken: "token", host: "" });

    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue(true);
    vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
    vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
    vi.mocked(appAuth.mintInstallationAuth).mockResolvedValue({
      type: "token",
      tokenType: "installation",
      token: "tok",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      installationId: 99,
    } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
    clearDurableAuthCachesForTest();
    vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
      userId: 999,
      login: "pr-agent[bot]",
    } as Awaited<ReturnType<typeof appAuth.getAppBotIdentity>>);
  });

  afterEach(async () => {
    await shutdownAnalytics();
  });

  it("forwards terminal failures to captureException with repo context", async () => {
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
      type: "review",
      cfg,
      pool,
      boss,
      job,
      resolveHeadSha: async () => ({ headSha: "abc123" }),
      execute,
    };

    await expect(runDurableWorkItem(spec)).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, null);
    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work item failed",
      properties: expect.objectContaining({
        type: "review",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        failure_domain: expect.any(String),
        error_kind: expect.any(String),
        error_message: expect.any(String),
      }),
    });
    expect(client?.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Error", message: "enqueue failed" }),
      "installation:99",
      expect.objectContaining({
        event: "agent_work_failed",
        type: "review",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        workItemId: "wi-1",
      }),
    );
  });

  it("classifies provider credit failures on work item failed", async () => {
    const item = makeReviewWorkItem({
      status: "running",
      id: "wi-credits",
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
      id: "job-credits",
      data: { workItemId: item.id },
      retryCount: 3,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobWithMetadata<{ workItemId: string }>;

    await expect(
      runDurableWorkItem({
        type: "review",
        cfg,
        pool,
        boss,
        job,
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute,
      }),
    ).resolves.toBeUndefined();

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: "work item failed",
      properties: expect.objectContaining({
        failure_domain: "provider",
        error_kind: "quota",
        error_message: expect.stringMatching(/credit/i),
        provider_error_kind: "quota",
      }),
    });
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
        type: "review",
        cfg,
        pool,
        boss,
        job,
        resolveHeadSha: async () => ({ headSha: "abc123" }),
        execute: vi.fn().mockRejectedValue(boom),
      }),
    ).resolves.toBeUndefined();

    const call = mockPostHog.instances[0]?.captureException.mock.calls[0];
    expect(call?.[0]).not.toBe(boom);
    expect(call?.[2]).toMatchObject({
      errorCode: "agent_work.failed",
      errorContext: { workItemId: item.id },
    });
    const json = JSON.stringify({ error: call?.[0], properties: call?.[2] });
    expect(json).not.toContain(token);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
