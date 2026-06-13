import { vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";
import type { AgentWorkItem } from "../../src/agentWork/types.js";
import { clearDurableAuthCachesForTest } from "../../src/agentWork/durableJob.js";
import * as appAuth from "../../src/github/appAuth.js";
import * as repo from "../../src/agentWork/repository.js";

export function coreOf(item: AgentWorkItem): Omit<AgentWorkItem, "payload"> {
  const { payload: _payload, ...core } = item;
  return core;
}

export function mockFetchedWorkItem(item: AgentWorkItem | null): void {
  vi.mocked(repo.getWorkItemCore).mockResolvedValue(item ? coreOf(item) : null);
  vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item?.payload ?? null);
}

export function setupDefaultDurableRepositoryMocks(): void {
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue(true);
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
  return {
    id: "job-1",
    data: { workItemId },
    retryCount,
    retryLimit,
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}
