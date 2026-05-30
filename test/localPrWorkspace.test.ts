import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { assertWorkspacePath, prepareLocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function testConfig(): Config {
  return {
    localWorkspaceCloneTimeoutMs: 30_000,
    localWorkspaceFetchTimeoutMs: 30_000,
    localWorkspaceMaxMaterializedFiles: 20,
    localWorkspaceMaxFileBytes: 100_000,
    localWorkspaceMaxTotalBytes: 1_000_000,
    localWorkspaceMaxDiffBytes: 1_000_000,
    localWorkspaceMinFreeSpaceBytes: 1,
    localWorkspaceStaleCleanupAgeSeconds: 1,
    localWorkspaceMaxBlameDeepenCommits: 10,
  } as Config;
}

describe("local PR workspace", () => {
  it("materializes changed files and builds a local diff index", async () => {
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
      await git(repo, ["push", "origin", `${baseSha}:refs/heads/base`]);

      const workspace = await prepareLocalPrWorkspace({
        cfg: testConfig(),
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        baseSha,
        baseRef: "base",
        headSha,
        installationToken: "unused",
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
        expect(await workspace.materializePath("support.txt")).toBe("materialized");
        expect(await readFile(join(workspace.agentCwd, "support.txt"), "utf8")).toContain("helper");
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
