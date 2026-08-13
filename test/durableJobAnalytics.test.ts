import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { runDurableWorkItem } from "../src/agentWork/durableJob.js";
import {
  initAnalytics,
  resetPostHogClientFactory,
  setPostHogClientFactory,
  shutdownAnalytics,
} from "../src/analytics/index.js";
import type { PostHogClientOptions } from "../src/analytics/posthogSink.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  mockFetchedWorkItem,
  resetDurablePrSurface,
  setupDefaultDurableAuthMocks,
  setupDefaultDurableRepositoryMocks,
} from "./helpers/executorDurableHarness.js";
import * as repo from "../src/agentWork/repository.js";
import * as reviewReschedule from "../src/agentWork/reviewReschedule.js";
import { resetCreatePrSurface, setCreatePrSurface } from "../src/github/prSurface.js";

const cfg = makeTestConfig();
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });

type FakePostHogClient = {
  readonly capture: Mock;
  readonly captureException: Mock;
  readonly shutdown: Mock;
};

const instances: FakePostHogClient[] = [];
const postHogFactory = vi.fn((_apiKey: string, _options: PostHogClientOptions) => {
  const client: FakePostHogClient = {
    capture: vi.fn(),
    captureException: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  };
  instances.push(client);
  return client;
});

describe("durableJob analytics forwarding", () => {
  beforeEach(async () => {
    instances.length = 0;
    postHogFactory.mockClear();
    setPostHogClientFactory(postHogFactory);
    await initAnalytics({ projectToken: "token", host: "" });
    resetDurablePrSurface();
    setCreatePrSurface(() => fakeDurablePrSurface());
    setupDefaultDurableRepositoryMocks();
    setupDefaultDurableAuthMocks();
    vi.spyOn(repo, "claimQueuedWorkItem").mockResolvedValue(null);
    vi.spyOn(
      reviewReschedule,
      "cancelOrphanedStaleHeadReplacementOnTerminalFailure",
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await shutdownAnalytics();
    resetPostHogClientFactory();
    resetCreatePrSurface();
    vi.restoreAllMocks();
    instances.length = 0;
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
    mockFetchedWorkItem(item);

    const boom = new Error("enqueue failed");
    const execute = vi.fn().mockRejectedValue(boom);
    const job = makeDurableJobMetadata(item.id, 3, 3);

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

    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    const client = instances[0];
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
      boom,
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
    mockFetchedWorkItem(item);

    const boom = new Error("Insufficient credits for model");
    const execute = vi.fn().mockRejectedValue(boom);
    const job = {
      ...makeDurableJobMetadata(item.id, 3, 3),
      id: "job-credits",
    };

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

    const client = instances[0];
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
});
