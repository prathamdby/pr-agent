import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.js";
import {
  assertWorkspacePath,
  prepareLocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";
import { makeTestConfig } from "./helpers/config.js";

const GIT_WORKSPACE_TEST_TIMEOUT_MS = 15_000;

const execFile = promisify(execFileCb);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
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

        const cfg = makeTestConfig();
        const fullWorkspace = await prepareLocalPrWorkspace({
          cfg,
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          repositorySizeKb: cfg.localWorkspaceFullCloneMaxRepoKb,
          remoteUrlOverride: remote,
        });
        try {
          expect(fullWorkspace.checkoutMode).toBe("full");
          expect(fullWorkspace.changedFiles.map((file) => file.path).toSorted()).toEqual([
            "renamed.txt",
            "src.txt",
          ]);
          expect(
            fullWorkspace.changedFiles.find((file) => file.path === "renamed.txt"),
          ).toMatchObject({
            status: "renamed",
            oldPath: "delete.txt",
          });
          expect(fullWorkspace.changedFileByPath.get("renamed.txt")).toMatchObject({
            status: "renamed",
            oldPath: "delete.txt",
          });
          expect(await readFile(join(fullWorkspace.agentCwd, "src.txt"), "utf8")).toContain("two");
          expect(fullWorkspace.checkoutPaths.has("support.txt")).toBe(true);
          expect(fullWorkspace.sortedCheckoutPaths).toEqual(
            [...fullWorkspace.checkoutPaths].toSorted(),
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
          expect(await fullWorkspace.getBlameForPath("src.txt")).toContain("src.txt");
          expect(fullWorkspace.diffIndex.listPullRequestFilesIngested).toBe(true);
          expect(
            fullWorkspace.diffIndex.files.get("src.txt")?.commentableRightLineRanges.length,
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
        } finally {
          await fullWorkspace.cleanup();
        }

        const noSizeWorkspace = await prepareLocalPrWorkspace({
          cfg,
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          remoteUrlOverride: remote,
        });
        try {
          expect(noSizeWorkspace.checkoutMode).toBe("full");
          expect(noSizeWorkspace.checkoutPaths.has("support.txt")).toBe(true);
        } finally {
          await noSizeWorkspace.cleanup();
        }

        const sparseWorkspace = await prepareLocalPrWorkspace({
          cfg,
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles,
          repositorySizeKb: cfg.localWorkspaceFullCloneMaxRepoKb + 1,
          remoteUrlOverride: remote,
        });
        try {
          expect(sparseWorkspace.checkoutMode).toBe("sparse");
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
          expect(sparseWorkspace.checkoutPaths.has("support.txt")).toBe(false);
          await expect(
            readFile(join(sparseWorkspace.agentCwd, "support.txt"), "utf8"),
          ).rejects.toThrow();
          expect(await sparseWorkspace.getBlameForPath("support.txt")).toBe("");
        } finally {
          await sparseWorkspace.cleanup();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    GIT_WORKSPACE_TEST_TIMEOUT_MS,
  );
});
