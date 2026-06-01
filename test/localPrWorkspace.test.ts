import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.js";
import {
  assertWorkspacePath,
  prepareLocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function testConfig(): Config {
  return {
    localWorkspaceCloneTimeoutMs: 30_000,
    localWorkspaceFetchTimeoutMs: 30_000,
    localWorkspaceSearchMaxFiles: 20,
    localWorkspaceMaxFileBytes: 100_000,
    localWorkspaceSearchMaxTotalBytes: 1_000_000,
    localWorkspaceMaxDiffBytes: 1_000_000,
    localWorkspaceMinFreeSpaceBytes: 1,
    localWorkspaceStaleCleanupAgeSeconds: 1,
    maxPrFilesListed: 300,
    maxPrFilesPatchBytes: 500_000,
  } as Config;
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
  const files: ListPullRequestFilesResult["files"] = [];
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
  it("checks out the full PR head tree and builds diff index from PR file metadata", async () => {
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
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      const baseSha = await git(repo, ["rev-parse", "HEAD"]);

      await writeFile(join(repo, "src.txt"), "one\ntwo\n");
      await git(repo, ["mv", "delete.txt", "renamed.txt"]);
      await writeFile(join(repo, "renamed.txt"), "renamed\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "head"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);

      await git(root, ["init", "--bare", remote]);
      await git(repo, ["remote", "add", "origin", remote]);
      await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

      const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);

      const workspace = await prepareLocalPrWorkspace({
        cfg: testConfig(),
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        installationToken: "unused",
        prFiles,
        remoteUrlOverride: remote,
      });
      try {
        expect(workspace.changedFiles.map((file) => file.path).toSorted()).toEqual([
          "delete.txt",
          "renamed.txt",
          "src.txt",
        ]);
        expect(workspace.changedFiles.find((file) => file.path === "delete.txt")?.status).toBe(
          "deleted",
        );
        expect(await readFile(join(workspace.agentCwd, "src.txt"), "utf8")).toContain("two");
        expect(workspace.checkoutPaths.has("support.txt")).toBe(true);
        expect(await readFile(join(workspace.agentCwd, "support.txt"), "utf8")).toContain("helper");
        expect(workspace.checkoutPaths.has("delete.txt")).toBe(false);
        expect(await workspace.getBlameForPath("src.txt")).toContain("src.txt");
        expect(workspace.diffIndex.listPullRequestFilesIngested).toBe(true);
        expect(
          workspace.diffIndex.files.get("src.txt")?.commentableRightLineRanges.length,
        ).toBeGreaterThan(0);
        expect(() => assertWorkspacePath(workspace.agentCwd, "../escape")).toThrow(/traversal/);
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
