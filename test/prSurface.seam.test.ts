import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import type { PrSurface } from "../src/github/prSurface.js";
import { createFakePrSurface, createPrSurface } from "../src/github/prSurface.js";

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

import { installationOctokit } from "../src/github/appAuth.js";
import { mintInstallationToken } from "../src/github/installationToken.js";

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
});
