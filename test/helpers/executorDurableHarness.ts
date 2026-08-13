import { vi } from "vitest";
import type { InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import type { JobWithMetadata } from "pg-boss";
import type { AgentWorkItem, AgentWorkItemCore } from "../../src/agentWork/types.js";
import { clearDurableAuthCachesForTest } from "../../src/agentWork/durableJob.js";
import * as appAuth from "../../src/github/appAuth.js";
import { createFakePrSurface, type FakePrSurfaceControls } from "../../src/github/prSurface.js";
import * as repo from "../../src/agentWork/repository.js";

let durableSurfaceBundle = createFakePrSurface(
  { owner: "o", repo: "r", prNumber: 1 },
  { headSha: "head", credentialToken: "tok" },
);

export function resetDurablePrSurface(
  params: { owner?: string; repo?: string; prNumber?: number; headSha?: string } = {},
) {
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

export function durablePrSurfaceControls(): FakePrSurfaceControls {
  return durableSurfaceBundle.controls;
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
  vi.spyOn(repo, "getWorkItemCore").mockResolvedValue(item ? coreOf(item) : null);
  vi.spyOn(repo, "getWorkItemPayload").mockResolvedValue(item?.payload);
}

export function setupDefaultDurableRepositoryMocks(): void {
  vi.spyOn(repo, "shouldSkipWork").mockResolvedValue(false);
  vi.spyOn(repo, "claimWorkForExecution").mockResolvedValue({ executionEpoch: 1 });
  vi.spyOn(repo, "isExecutionEpochCurrent").mockResolvedValue(true);
  vi.spyOn(repo, "updateRunningWorkHeadSha").mockResolvedValue(true);
  vi.spyOn(repo, "markWorkCompleted").mockResolvedValue(true);
  vi.spyOn(repo, "markWorkFailed").mockResolvedValue(true);
  vi.spyOn(repo, "markWorkRetrying").mockResolvedValue(true);
  vi.spyOn(repo, "markWorkCancelled").mockResolvedValue(undefined);
  vi.spyOn(repo, "markWorkPublishDegraded").mockResolvedValue(undefined);
}

export function setupDefaultDurableAuthMocks(): void {
  clearDurableAuthCachesForTest();
  const auth: InstallationAccessTokenAuthentication = {
    type: "token",
    tokenType: "installation",
    token: "tok",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {},
    repositorySelection: "all",
    installationId: 42,
  };
  vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue(auth);
  vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
    userId: 999,
    login: "pr-agent[bot]",
  });
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
