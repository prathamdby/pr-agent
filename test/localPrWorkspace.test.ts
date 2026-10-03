import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.js";
import { LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB } from "../src/settings/index.js";

const credentialHooks = { failAfterWrite: false };
const allocatedWorkspaceRoots: string[] = [];
vi.mock("../src/prWorkspace/gitCredentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prWorkspace/gitCredentials.js")>();
  return {
    ...actual,
    async createGitCredentialFiles(rootDir: string, token: string) {
      allocatedWorkspaceRoots.push(rootDir);
      const created = await actual.createGitCredentialFiles(rootDir, token);
      if (credentialHooks.failAfterWrite) {
        throw new Error("injected credential setup failure");
      }
      return created;
    },
  };
});

afterEach(() => {
  credentialHooks.failAfterWrite = false;
  allocatedWorkspaceRoots.length = 0;
});
import { prepareLocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";
import { assertWorkspacePath, buildCheckoutCoverage } from "../src/prWorkspace/repositoryReader.js";
import * as symbolIndexModule from "../src/prWorkspace/symbolIndex.js";

const GIT_WORKSPACE_TEST_TIMEOUT_MS = 15_000;

const execFile = promisify(execFileCb);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function expectAllocatedWorkspaceRootsRemoved(): Promise<void> {
  expect(allocatedWorkspaceRoots).not.toEqual([]);
  await Promise.all(
    allocatedWorkspaceRoots.map((rootDir) =>
      expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" }),
    ),
  );
}

async function buildPrFilesFromRepo(
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<ListPullRequestFilesResult> {
  const nameStatus = await git(repo, [
    "diff",
    "--name-status",
    "--find-renames",
    `${baseSha}..${headSha}`,
  ]);
  const files: Array<ListPullRequestFilesResult["files"][number]> = [];
  let totalChanges = 0;

  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [rawStatus, firstPath, secondPath] = line.split("\t");
    const code = rawStatus?.[0] ?? "";
    let filename = firstPath ?? "";
    let previousFilename: string | undefined;
    let status = "modified";

    if (code === "R" && firstPath && secondPath) {
      status = "renamed";
      previousFilename = firstPath;
      filename = secondPath;
    } else if (code === "A") {
      status = "added";
    } else if (code === "D") {
      status = "removed";
    } else if (code === "M") {
      status = "modified";
    }

    const patch = await git(repo, ["diff", `${baseSha}..${headSha}`, "--", filename]).catch(
      () => "",
    );
    const numstatLine = await git(repo, [
      "diff",
      "--numstat",
      `${baseSha}..${headSha}`,
      "--",
      filename,
    ]).catch(() => "0\t0");
    const [addedRaw, deletedRaw] = numstatLine.split("\t");
    const additions = Number(addedRaw) || 0;
    const deletions = Number(deletedRaw) || 0;
    const changes = additions + deletions;
    totalChanges += changes;

    files.push({
      filename,
      status,
      additions,
      deletions,
      changes,
      ...(previousFilename ? { previousFilename } : {}),
      ...(patch ? { patch } : {}),
    });
  }

  return { files, truncated: false, omittedCountLowerBound: 0, totalChanges };
}

describe("local PR workspace", () => {
  it("buildCheckoutCoverage reflects sparse mode and truncation stats", () => {
    const sparseCoverage = buildCheckoutCoverage({
      checkoutMode: "sparse",
      checkoutPaths: new Set(["src/a.ts", "src/b.ts"]),
      changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
      stats: { truncated: true, warning: "file list capped" },
      searchTruncated: true,
    });
    expect(sparseCoverage).toEqual({
      mode: "sparse",
      pathsInCheckout: 2,
      changedFileCount: 3,
      changeSetTruncated: true,
      searchTruncated: true,
      warning: "file list capped",
    });

    const fullCoverage = buildCheckoutCoverage({
      checkoutMode: "full",
      checkoutPaths: new Set(["src/a.ts", "lib/b.ts", "README.md"]),
      changedFiles: [{ path: "src/a.ts" }],
      stats: { truncated: false },
    });
    expect(fullCoverage).toEqual({
      mode: "full",
      pathsInCheckout: 3,
      changedFileCount: 1,
      changeSetTruncated: false,
    });
  });

  it(
    "uses full checkout below the repo size cap and sparse checkout above it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-test-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "src.txt"), "one\n");
        await writeFile(join(repo, "delete.txt"), "gone\n");
        await writeFile(join(repo, "support.txt"), "helper\n");
        await symlink("support.txt", join(repo, "support-link.txt"));
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "base"]);
        const baseSha = await git(repo, ["rev-parse", "HEAD"]);

        await writeFile(join(repo, "src.txt"), "one\ntwo\n");
        await git(repo, ["mv", "delete.txt", "renamed.txt"]);
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "head"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await git(root, ["init", "--bare", remote]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

        const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);
        const fullWorkspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
          remoteUrlOverride: remote,
        });
        try {
          expect(fullWorkspace.reader.checkoutMode).toBe("full");
          expect(fullWorkspace.reader.changedFiles.map((file) => file.path).toSorted()).toEqual([
            "renamed.txt",
            "src.txt",
          ]);
          expect(
            fullWorkspace.reader.changedFiles.find((file) => file.path === "renamed.txt"),
          ).toMatchObject({
            status: "renamed",
            oldPath: "delete.txt",
          });
          expect(fullWorkspace.reader.changedFileByPath.get("renamed.txt")).toMatchObject({
            status: "renamed",
            oldPath: "delete.txt",
          });
          expect(await readFile(join(fullWorkspace.agentCwd, "src.txt"), "utf8")).toContain("two");
          expect(fullWorkspace.reader.checkoutPaths.has("support.txt")).toBe(true);
          expect(fullWorkspace.reader.sortedCheckoutPaths).toEqual(
            [...fullWorkspace.reader.checkoutPaths].toSorted(),
          );
          expect(await readFile(join(fullWorkspace.agentCwd, "support.txt"), "utf8")).toContain(
            "helper",
          );
          await expect(
            readFile(join(fullWorkspace.agentCwd, "support-link.txt"), "utf8"),
          ).rejects.toThrow();
          await expect(
            writeFile(join(fullWorkspace.agentCwd, "src.txt"), "mutate"),
          ).rejects.toThrow();
          expect(await fullWorkspace.reader.getBlameForPath("src.txt")).toContain("src.txt");
          expect(fullWorkspace.reader.diffIndex.listPullRequestFilesIngested).toBe(true);
          expect(
            fullWorkspace.reader.diffIndex.files.get("src.txt")?.commentableRightLineRanges.length,
          ).toBeGreaterThan(0);
          const fullPartialCloneFilter = await git(root, [
            "--git-dir",
            fullWorkspace.privateGitDir,
            "config",
            "--get",
            "remote.origin.partialclonefilter",
          ]).catch(() => "");
          expect(fullPartialCloneFilter).toBe("");
          expect(() => assertWorkspacePath(fullWorkspace.agentCwd, "../escape")).toThrow(
            /traversal/,
          );
          expect(fullWorkspace.reader.getCoverage()).toMatchObject({
            mode: "full",
            changeSetTruncated: false,
          });
        } finally {
          await fullWorkspace.cleanup();
        }

        const noSizeWorkspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          remoteUrlOverride: remote,
        });
        try {
          expect(noSizeWorkspace.reader.checkoutMode).toBe("full");
          expect(noSizeWorkspace.reader.checkoutPaths.has("support.txt")).toBe(true);
        } finally {
          await noSizeWorkspace.cleanup();
        }

        const sparseWorkspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB + 1,
          remoteUrlOverride: remote,
        });
        try {
          expect(sparseWorkspace.reader.checkoutMode).toBe("sparse");
          const sparsePartialCloneFilter = await git(root, [
            "--git-dir",
            sparseWorkspace.privateGitDir,
            "config",
            "--get",
            "remote.origin.partialclonefilter",
          ]);
          expect(sparsePartialCloneFilter).toBe("blob:none");
          expect(await readFile(join(sparseWorkspace.agentCwd, "src.txt"), "utf8")).toContain(
            "two",
          );
          expect(await readFile(join(sparseWorkspace.agentCwd, "renamed.txt"), "utf8")).toContain(
            "gone",
          );
          expect(sparseWorkspace.reader.checkoutPaths.has("support.txt")).toBe(false);
          await expect(
            readFile(join(sparseWorkspace.agentCwd, "support.txt"), "utf8"),
          ).rejects.toThrow();
          expect(await sparseWorkspace.reader.getBlameForPath("support.txt")).toBe("");
          expect(sparseWorkspace.reader.getCoverage()).toMatchObject({
            mode: "sparse",
            changeSetTruncated: false,
          });
          expect(sparseWorkspace.reader.getCoverage().pathsInCheckout).toBe(
            sparseWorkspace.reader.checkoutPaths.size,
          );
        } finally {
          await sparseWorkspace.cleanup();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    GIT_WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects oversized fetches before checkout and cleans up the workspace",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-fetch-cap-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "src.txt"), "one\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "base"]);
        const baseSha = await git(repo, ["rev-parse", "HEAD"]);

        await writeFile(join(repo, "src.txt"), "one\ntwo\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "head"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await git(root, ["init", "--bare", remote]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

        const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);

        await expect(
          prepareLocalPrWorkspace({
            owner: "owner",
            repo: "repo",
            prNumber: 1,
            headSha,
            installationToken: "unused",
            prFiles,
            remoteUrlOverride: remote,
            maxFetchBytes: 1,
          }),
        ).rejects.toThrow(/LOCAL_WORKSPACE_MAX_FETCH_BYTES/);

        await expectAllocatedWorkspaceRootsRemoved();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    GIT_WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects oversized sparse checkouts after blob hydration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-sparse-fetch-cap-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "src.txt"), "one\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "base"]);
        const baseSha = await git(repo, ["rev-parse", "HEAD"]);

        await writeFile(join(repo, "src.txt"), "one\ntwo\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "head"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await git(root, ["init", "--bare", remote]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

        const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);

        await expect(
          prepareLocalPrWorkspace({
            owner: "owner",
            repo: "repo",
            prNumber: 1,
            headSha,
            installationToken: "unused",
            prFiles,
            repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB + 1,
            remoteUrlOverride: remote,
            maxFetchBytes: 1,
          }),
        ).rejects.toThrow(/LOCAL_WORKSPACE_MAX_FETCH_BYTES/);

        await expectAllocatedWorkspaceRootsRemoved();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    GIT_WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "builds a symbol index for checkout paths and tolerates index build failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-symbol-index-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "src.ts"), "export function foo() { return 1; }\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "base"]);
        const baseSha = await git(repo, ["rev-parse", "HEAD"]);

        await writeFile(join(repo, "src.ts"), "export function foo() { return 2; }\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "head"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await git(root, ["init", "--bare", remote]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

        const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);
        const workspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          remoteUrlOverride: remote,
        });
        try {
          expect(workspace.reader.getSymbolIndexStatus().available).toBe(true);
          expect(workspace.reader.lookupSymbol("foo")).toEqual([
            { path: "src.ts", line: 1, kind: "function" },
          ]);
        } finally {
          await workspace.cleanup();
        }

        const buildSpy = vi
          .spyOn(symbolIndexModule, "buildSymbolIndex")
          .mockRejectedValueOnce(new Error("simulated index failure"));
        const failedWorkspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          remoteUrlOverride: remote,
        });
        try {
          expect(failedWorkspace.reader.getSymbolIndexStatus()).toEqual({ available: false });
          expect(failedWorkspace.reader.lookupSymbol("foo")).toEqual([]);
        } finally {
          buildSpy.mockRestore();
          await failedWorkspace.cleanup();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    GIT_WORKSPACE_TEST_TIMEOUT_MS,
  );

  it("releases root and credential files after injected credential-setup failure", async () => {
    credentialHooks.failAfterWrite = true;
    await expect(
      prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha: "a".repeat(40),
        installationToken: "ghs_INJECTED_CREDENTIAL_FAILURE_TOKEN",
        prFiles: { files: [], truncated: false, omittedCountLowerBound: 0, totalChanges: 0 },
      }),
    ).rejects.toThrow(/injected credential setup failure/);
    await expectAllocatedWorkspaceRootsRemoved();
  });
});
