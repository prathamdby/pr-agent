import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import type { PrSurface } from "../src/github/prSurface.js";
import { createFakePrSurface, createPrSurface } from "../src/github/prSurface.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";

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
import { mintInstallationToken } from "../src/github/installationToken.js";
import { createReviewCheckRun, findReviewCheckRunByName } from "../src/github/reviewPublish.js";

const SENTINEL = "<!-- pr-agent-progress -->";

async function sharedProgressCommentScenarios(surface: PrSurface): Promise<void> {
  const first = await surface.upsertProgressComment(`${SENTINEL}\nstarting`, SENTINEL);
  expect(first.updated).toBe(false);

  const second = await surface.upsertProgressComment(`${SENTINEL}\ndone`, SENTINEL);
  expect(second.updated).toBe(true);
  expect(second.id).toBe(first.id);
}

describe("PrSurface seam", () => {
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
    } as never);

    const expiresAtTs = Date.now() + 3_600_000;
    const real = createPrSurface({
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
});
