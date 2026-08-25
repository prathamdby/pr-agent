import { describe, expect, it, vi } from "vitest";
import {
  isPullRequestOpenAndUnmerged,
  listPullRequestFilesPaginated,
  type PullRequestForFileList,
} from "../src/github/listPullRequestFiles.js";
import { installationOctokit } from "../src/github/appAuth.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

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
    expect(out.omittedCountLowerBound).toBe(0);
    expect(out.warning).toBeUndefined();
  });

  it("marks the file list truncated and warns when changed_files exceeds the listing cap", async () => {
    const page = Array.from({ length: 3 }, (_, i) => ({
      filename: `capped${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: `@@capped${i}`,
    }));
    const pullsListFiles = vi.fn().mockResolvedValue({ data: page });

    const out = await listPullRequestFilesPaginated(
      makeOctokitStub(pullsListFiles),
      "o",
      "r",
      3,
      { maxPrFilesListed: 2, maxPrFilesPatchBytes: 500_000 },
      {
        additions: 5,
        deletions: 0,
        changed_files: 5,
      },
    );

    expect(out.files).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.omittedCountLowerBound).toBe(3);
    expect(out.warning).toContain("Change set truncated to 2 files (3 omitted).");
  });

  it("treats patch-byte caps as provenance by omitting later patches and warning", async () => {
    const pullsListFiles = vi.fn().mockResolvedValue({
      data: [
        {
          filename: "kept.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "aa",
        },
        {
          filename: "omitted.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "bbbb",
        },
      ],
    });

    const out = await listPullRequestFilesPaginated(
      makeOctokitStub(pullsListFiles),
      "o",
      "r",
      3,
      { maxPrFilesListed: 300, maxPrFilesPatchBytes: 2 },
      {
        additions: 2,
        deletions: 0,
        changed_files: 2,
      },
    );

    expect(out.truncated).toBe(false);
    expect(out.files[0]?.patch).toBe("aa");
    expect(out.files[1]?.patch).toBeUndefined();
    expect(out.files[1]?.patchOmitted).toBe(true);
    expect(out.warning).toContain("Unified diff patches omitted for 1 file(s) after 2 byte cap.");
  });
});

describe("isPullRequestOpenAndUnmerged", () => {
  const base: PullRequestForFileList = {
    additions: 0,
    deletions: 0,
    changed_files: 0,
    state: "open",
    merged: false,
    merged_at: null,
  };

  it.each([
    ["complete open and unmerged state", base, true],
    ["missing state", { ...base, state: undefined }, false],
    ["missing merged flag", { ...base, merged: undefined }, false],
    ["missing merged timestamp", { ...base, merged_at: undefined }, false],
    ["open but merged", { ...base, merged: true }, false],
    ["open with a merge timestamp", { ...base, merged_at: "2026-01-01T00:00:00Z" }, false],
    ["closed and unmerged", { ...base, state: "closed" }, false],
  ] as const)("fails closed for %s", (_label, pullRequest, expected) => {
    expect(isPullRequestOpenAndUnmerged(pullRequest)).toBe(expected);
  });

  it("keeps the fake surface default write-eligible", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });

    expect(isPullRequestOpenAndUnmerged((await fake.surface.getHead()).pullRequest)).toBe(true);
  });
});
