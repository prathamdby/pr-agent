import { beforeEach, describe, expect, it, vi } from "vitest";
vi.unmock("../src/github/ciStatus.js");
import { makeTestConfig } from "./helpers/config.js";
import type { PrSurface } from "../src/github/prSurface.js";
import { createFakePrSurface, createPrSurface } from "../src/github/prSurface.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";
import {
  installationCapabilitiesFromPermissions,
  createReviewCapabilityPolicy,
} from "../src/github/installationCapabilities.js";

const reviewPublishMocks = vi.hoisted(() => ({
  createReviewCheckRun: vi.fn(),
  findReviewCheckRunByName: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(),
  getAppBotIdentity: vi.fn(async () => ({ userId: 99, login: "pr-agent[bot]" })),
  mintInstallationAuth: vi.fn(),
}));

vi.mock("../src/github/installationToken.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/installationToken.js")>();
  return {
    ...actual,
    mintInstallationToken: vi.fn(),
  };
});

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    createReviewCheckRun: reviewPublishMocks.createReviewCheckRun,
    findReviewCheckRunByName: reviewPublishMocks.findReviewCheckRunByName,
  };
});

import { installationOctokit } from "../src/github/appAuth.js";

function pageData(raw: unknown): unknown {
  if (Array.isArray(raw) || raw == null || typeof raw !== "object") return raw;
  if ("check_runs" in raw) return raw.check_runs;
  if ("workflow_runs" in raw) return raw.workflow_runs;
  if ("jobs" in raw) return raw.jobs;
  return raw;
}

async function paginateMock(
  route: (params: unknown) => Promise<{ data?: unknown }>,
  params: unknown,
  map?: (response: { data: unknown }, done: () => void) => unknown,
) {
  if (!map) {
    const response = await route(params);
    return pageData(response?.data);
  }
  const base = params != null && typeof params === "object" ? params : {};
  const perPage = "per_page" in base && typeof base.per_page === "number" ? base.per_page : 100;
  const items: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    let stop = false;
    const response = await route({ ...base, page });
    const data = pageData(response?.data);
    const pageItems = await map({ ...response, data }, () => {
      stop = true;
    });
    if (Array.isArray(pageItems)) items.push(...pageItems);
    const length = Array.isArray(data) ? data.length : 0;
    if (stop || length === 0 || length < perPage) break;
  }
  return items;
}
import { mintInstallationToken } from "../src/github/installationToken.js";
import { createReviewCheckRun, findReviewCheckRunByName } from "../src/github/reviewPublish.js";
import { unfencedSurface } from "../src/agentWork/writeFence.js";

const SENTINEL = "<!-- pr-agent-progress -->";

async function sharedProgressCommentScenarios(surface: PrSurface): Promise<void> {
  const first = await surface.upsertProgressComment(`${SENTINEL}\nstarting`, SENTINEL);
  expect(first.updated).toBe(false);

  const second = await surface.upsertProgressComment(`${SENTINEL}\ndone`, SENTINEL);
  expect(second.updated).toBe(true);
  expect(second.id).toBe(first.id);
}

describe("PrSurface seam", () => {
  it.each([false, true])(
    "reads verdict statuses without Checks and refuses incomplete status evidence (%s)",
    async (incomplete) => {
      const policy = createReviewCapabilityPolicy(
        installationCapabilitiesFromPermissions({
          scope: { appId: "1", installationId: 42, owner: "o", repo: "r" },
          generation: "1",
          permissions: { statuses: "read" },
        }),
      );
      const getCombinedStatusForRef = vi.fn(async () => ({
        data: {
          statuses: Array.from({ length: incomplete ? 100 : 1 }, (_, index) => ({
            context: index === 0 ? "pr-agent/review" : `ci-${index}`,
            state: "success",
            description: "accepted",
            target_url: null,
            updated_at: "2026-10-03T00:00:00Z",
            created_at: "2026-10-03T00:00:00Z",
          })),
        },
      }));
      const listForRef = vi.fn();
      vi.mocked(installationOctokit).mockReturnValue({
        rest: { repos: { getCombinedStatusForRef }, checks: { listForRef } },
      } as never);
      const surface = createPrSurface({
        mutationBoundary: unfencedSurface(),
        cfg: makeTestConfig(),
        installationId: 42,
        owner: "o",
        repo: "r",
        prNumber: 5,
        installation: { token: "seed", expiresAtTs: Date.now() + 3_600_000, ttlMs: 3_600_000 },
        capabilities: policy,
      });
      const statuses = surface.getReviewCommitStatuses?.("head");
      if (incomplete) {
        await expect(statuses).rejects.toMatchObject({ code: "github.preflight_unavailable" });
      } else {
        await expect(statuses).resolves.toEqual([
          expect.objectContaining({ context: "pr-agent/review", state: "success" }),
        ]);
      }
      expect(listForRef).not.toHaveBeenCalled();
    },
  );

  it("permits real head and identity reads but blocks new publication with revoked write grants", async () => {
    const policy = createReviewCapabilityPolicy(
      installationCapabilitiesFromPermissions({
        scope: { appId: "1", installationId: 42, owner: "o", repo: "r" },
        generation: "1",
        permissions: { contents: "read", pull_requests: "read" },
      }),
    );
    const pullsGet = vi.fn(async () => ({
      data: { head: { sha: "live-head" }, additions: 0, deletions: 0, changed_files: 0 },
    }));
    const createReview = vi.fn();
    vi.mocked(installationOctokit).mockReturnValue({
      rest: { pulls: { get: pullsGet, createReview } },
    } as never);
    const tokenResolver = vi.fn(async () => ({
      token: "managed",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
    }));
    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
      prNumber: 5,
      tokenResolver,
      capabilities: policy,
    });
    await expect(surface.getHeadSha()).resolves.toBe("live-head");
    await expect(surface.getBotLogin()).resolves.toBe("pr-agent[bot]");
    await expect(
      surface.publishThreadBatch({ body: "new output", event: "COMMENT" }),
    ).rejects.toMatchObject({
      code: "github.essential_access_denied",
    });
    expect(createReview).not.toHaveBeenCalled();
    expect(pullsGet).toHaveBeenCalledTimes(1);
  });

  it("persists Actions denial exposed by the read helper without denying other operations", async () => {
    const persist = vi.fn(async () => {});
    const policy = createReviewCapabilityPolicy(
      installationCapabilitiesFromPermissions({
        scope: { appId: "1", installationId: 42, owner: "o", repo: "r" },
        generation: "1",
        permissions: { actions: "read", checks: "read" },
      }),
      persist,
    );
    const listWorkflowRunsForRepo = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      );
    vi.mocked(installationOctokit).mockReturnValue({
      rest: { actions: { listWorkflowRunsForRepo } },
      paginate: paginateMock,
    } as never);
    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
      prNumber: 5,
      installation: { token: "seed", expiresAtTs: Date.now() + 3_600_000, ttlMs: 3_600_000 },
      capabilities: policy,
    });
    await expect(surface.listFailingActionsJobs("head")).resolves.toEqual({
      ok: false,
      reason: "actions_permission",
    });
    expect(policy.access("actionsRead")).toBe("denied");
    expect(policy.access("checksRead")).toBe("available");
    expect(persist).toHaveBeenCalledWith("actionsRead");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    reviewPublishMocks.createReviewCheckRun.mockReset();
    reviewPublishMocks.findReviewCheckRunByName.mockReset();
  });

  it("createPrSurface with seed token uses installationOctokit with token and expiry on getHeadSha", async () => {
    const expiresAtTs = Date.now() + 3_600_000;
    const pullsGet = vi.fn(async () => ({
      data: {
        head: { sha: "abc123" },
        additions: 1,
        deletions: 0,
        title: "",
        body: null,
        changed_files: 1,
      },
    }));
    vi.mocked(installationOctokit).mockReturnValue({
      rest: { pulls: { get: pullsGet } },
    } as never);
    vi.mocked(mintInstallationToken).mockResolvedValue({
      token: "should-not-mint",
      expiresAtTs,
      ttlMs: 3_600_000,
    });

    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
      prNumber: 5,
      installation: {
        token: "seed-token",
        expiresAtTs,
        ttlMs: 3_600_000,
      },
    });

    await expect(surface.getHeadSha()).resolves.toBe("abc123");
    expect(mintInstallationToken).not.toHaveBeenCalled();
    expect(installationOctokit).toHaveBeenCalledWith("seed-token", expiresAtTs);
    expect(pullsGet).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
    });
  });

  it("fake and real adapters agree on upsertProgressComment state transitions", async () => {
    const { surface: fake } = createFakePrSurface({
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    await sharedProgressCommentScenarios(fake);

    const storedComments: Array<{ id: number; body: string; html_url: string }> = [];
    const listComments = vi.fn(async () => ({ data: [...storedComments] }));
    const createComment = vi.fn(async (args: { body: string }) => {
      const comment = {
        id: 100,
        body: args.body,
        html_url: "https://github.com/o/r/issues/1#issuecomment-100",
      };
      storedComments.push(comment);
      return { data: comment };
    });
    const updateComment = vi.fn(async (args: { comment_id: number; body: string }) => {
      const existing = storedComments.find((c) => c.id === args.comment_id);
      if (existing) existing.body = args.body;
      return { data: {} };
    });

    vi.mocked(installationOctokit).mockReturnValue({
      rest: {
        issues: {
          listComments,
          createComment,
          updateComment,
        },
      },
      paginate: paginateMock,
    } as never);

    const expiresAtTs = Date.now() + 3_600_000;
    const real = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 1,
      owner: "o",
      repo: "r",
      prNumber: 1,
      installation: { token: "tok", expiresAtTs, ttlMs: 3_600_000 },
    });
    await sharedProgressCommentScenarios(real);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
  });

  it("remints a near-expiry seed token once and reuses fresh auth", async () => {
    const now = Date.now();
    const nearExpiry = now + TOKEN_FRESHNESS_BUFFER_MS - 1;
    const freshExpiry = now + 3_600_000;
    const pullsGet = vi.fn(async () => ({
      data: {
        head: { sha: "abc123" },
        additions: 1,
        deletions: 0,
        title: "",
        body: null,
        changed_files: 1,
      },
    }));
    vi.mocked(installationOctokit).mockReturnValue({
      rest: { pulls: { get: pullsGet } },
    } as never);
    vi.mocked(mintInstallationToken).mockResolvedValue({
      token: "fresh-token",
      expiresAtTs: freshExpiry,
      ttlMs: 3_600_000,
    });

    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
      prNumber: 5,
      installation: {
        token: "seed-token",
        expiresAtTs: nearExpiry,
        ttlMs: 1_000,
      },
    });

    await expect(surface.getHeadSha()).resolves.toBe("abc123");
    await expect(surface.getHeadSha()).resolves.toBe("abc123");
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(installationOctokit).toHaveBeenLastCalledWith("fresh-token", freshExpiry);
  });

  it("resolves managed credentials on every operation including git checkout", async () => {
    const expiresAtTs = Date.now() + 3_600_000;
    const tokenResolver = vi.fn(async () => ({
      token: "managed",
      expiresAtTs,
      ttlMs: 3_600_000,
    }));
    const pullsGet = vi.fn(async () => ({
      data: { head: { sha: "abc" }, additions: 0, deletions: 0, changed_files: 0 },
    }));
    vi.mocked(installationOctokit).mockReturnValue({
      rest: { pulls: { get: pullsGet } },
    } as never);
    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
      prNumber: 5,
      installation: { token: "seed", expiresAtTs, ttlMs: 3_600_000 },
      tokenResolver,
    });
    await surface.getHead();
    await surface.gitCredentialAuth();
    expect(tokenResolver).toHaveBeenCalledTimes(2);
    expect(installationOctokit).toHaveBeenCalledWith("managed", expiresAtTs);
  });

  it("startReviewCheck returns duplicate id for a proven duplicate-create error", async () => {
    const duplicateError = Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [{ resource: "CheckRun", code: "already_exists", field: "name" }],
        },
      },
    });
    vi.mocked(createReviewCheckRun).mockRejectedValue(duplicateError);
    vi.mocked(findReviewCheckRunByName).mockResolvedValue({
      id: 777,
      url: "https://github.com/o/r/runs/777",
    });

    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 1,
      owner: "o",
      repo: "r",
      prNumber: 1,
      installation: {
        token: "tok",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      },
    });

    await expect(surface.startReviewCheck("abc123", "work-1")).resolves.toEqual({
      id: 777,
      url: "https://github.com/o/r/runs/777",
    });
    expect(findReviewCheckRunByName).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      "abc123",
      "PR Agent Review",
      "work-1",
      expect.any(Number),
    );
  });

  it("startReviewCheck rejects the original duplicate error when identity lookup returns null", async () => {
    const duplicateError = Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [{ resource: "CheckRun", code: "already_exists", field: "name" }],
        },
      },
    });
    vi.mocked(createReviewCheckRun).mockRejectedValue(duplicateError);
    vi.mocked(findReviewCheckRunByName).mockResolvedValue(null);

    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 1,
      owner: "o",
      repo: "r",
      prNumber: 1,
      installation: {
        token: "tok",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      },
    });

    await expect(surface.startReviewCheck("abc123", "work-1")).rejects.toBe(duplicateError);
  });

  it("does not recover an unrelated 422", async () => {
    const validationError = Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [{ resource: "CheckRun", code: "invalid", field: "head_sha" }],
        },
      },
    });
    vi.mocked(createReviewCheckRun).mockRejectedValue(validationError);

    const surface = createPrSurface({
      mutationBoundary: unfencedSurface(),
      cfg: makeTestConfig(),
      installationId: 1,
      owner: "o",
      repo: "r",
      prNumber: 1,
      installation: {
        token: "tok",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
      },
    });

    await expect(surface.startReviewCheck("abc123", "work-1")).rejects.toBe(validationError);
    expect(findReviewCheckRunByName).not.toHaveBeenCalled();
  });

  it("does not recover duplicate-like errors with a non-422 status", async () => {
    for (const status of [403, 500]) {
      const error = Object.assign(new Error("already exists"), {
        status,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "already_exists" }],
          },
        },
      });
      vi.mocked(createReviewCheckRun).mockRejectedValueOnce(error);

      const surface = createPrSurface({
        mutationBoundary: unfencedSurface(),
        cfg: makeTestConfig(),
        installationId: 1,
        owner: "o",
        repo: "r",
        prNumber: 1,
        installation: {
          token: "tok",
          expiresAtTs: Date.now() + 3_600_000,
          ttlMs: 3_600_000,
        },
      });

      await expect(surface.startReviewCheck("abc123", "work-1")).rejects.toBe(error);
    }
    expect(findReviewCheckRunByName).not.toHaveBeenCalled();
  });
});
