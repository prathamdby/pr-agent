import { describe, expect, it, vi } from "vitest";
import { listPullRequestFilesPaginated } from "../src/github/listPullRequestFiles.js";
import { installationOctokit } from "../src/github/appAuth.js";

function makeOctokitStub(pullsListFiles: ReturnType<typeof vi.fn>) {
  return {
    rest: {
      pulls: {
        listFiles: pullsListFiles,
      },
    },
  } as unknown as ReturnType<typeof installationOctokit>;
}

describe("listPullRequestFilesPaginated", () => {
  it("paginates past a stale prefetched changed_files count", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `a${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: `@@a${i}`,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      filename: `b${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: `@@b${i}`,
    }));
    const pullsListFiles = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const out = await listPullRequestFilesPaginated(
      makeOctokitStub(pullsListFiles),
      "o",
      "r",
      3,
      { maxPrFilesListed: 300, maxPrFilesPatchBytes: 500_000 },
      {
        additions: 50,
        deletions: 0,
        changed_files: 50,
      },
    );

    expect(pullsListFiles).toHaveBeenCalledTimes(2);
    expect(out.files).toHaveLength(150);
    expect(out.truncated).toBe(false);
  });

  it("exposes head and base identity from the pull metadata", async () => {
    const pullsListFiles = vi.fn().mockResolvedValueOnce({
      data: [
        {
          filename: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@a",
        },
      ],
    });

    const out = await listPullRequestFilesPaginated(
      makeOctokitStub(pullsListFiles),
      "o",
      "r",
      3,
      { maxPrFilesListed: 300, maxPrFilesPatchBytes: 500_000 },
      {
        additions: 1,
        deletions: 0,
        changed_files: 1,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40), ref: "main" },
      },
    );

    expect(out.headSha).toBe("a".repeat(40));
    expect(out.baseSha).toBe("b".repeat(40));
    expect(out.baseRef).toBe("main");
  });
});
