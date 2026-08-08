import { vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";
import type { AgentWorkItem, AgentWorkItemCore } from "../../src/agentWork/types.js";
import { clearDurableAuthCachesForTest } from "../../src/agentWork/durableJob.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as repo from "../../src/agentWork/repository.js";

export function coreOf(item: AgentWorkItem): AgentWorkItemCore {
  switch (item.type) {
    case "review": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "ask": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "description": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "triage": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "verification": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

export function mockFetchedWorkItem(item: AgentWorkItem | null): void {
  vi.mocked(repo.getWorkItemCore).mockResolvedValue(item ? coreOf(item) : null);
  vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item?.payload);
}

export function setupDefaultDurableRepositoryMocks(): void {
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue({ executionEpoch: 1 });
  vi.mocked(repo.isExecutionEpochCurrent).mockResolvedValue(true);
  vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
  vi.mocked(repo.markWorkCompleted).mockResolvedValue(true);
  vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
  vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
  vi.mocked(repo.markWorkCancelled).mockResolvedValue(undefined);
  vi.mocked(repo.markWorkPublishDegraded).mockResolvedValue(undefined);
}

export function setupDefaultDurableAuthMocks(): void {
  clearDurableAuthCachesForTest();
  vi.mocked(appAuth.mintInstallationAuth).mockResolvedValue({
    type: "token",
    tokenType: "installation",
    token: "tok",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    installationId: 42,
  } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
  vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
    userId: 999,
    login: "pr-agent[bot]",
  } as Awaited<ReturnType<typeof appAuth.getAppBotIdentity>>);
}

export function makeDurableJobMetadata(
  workItemId = "wi-1",
  retryCount = 0,
  retryLimit = 3,
): JobWithMetadata<{ workItemId: string }> {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work",
    data: { workItemId },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active",
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
    policy: "standard",
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
  };
}
