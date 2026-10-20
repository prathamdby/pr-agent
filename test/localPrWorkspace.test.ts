import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.ts";
import {
  isAllowlistedPolicyPath,
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
} from "../src/settings/index.ts";
import { type AppError, isAppError, serializeAppError } from "../src/errors/appError.ts";
import { classifyFailure } from "../src/errors/classifiedFailure.ts";
import { retryDispositionFor } from "../src/agentWork/retryPolicy.ts";
import { annotateExecution, initTraces, startWorkTrace } from "../src/traces/recorder.ts";
import { workspaceCheckoutProperties } from "../src/prWorkspace/checkoutTelemetry.ts";
import { readBasePolicySnapshot } from "../src/prWorkspace/policySnapshot.ts";
import { makeTestConfig } from "./helpers/config.ts";

const credentialHooks = { failAfterWrite: false };
const allocatedWorkspaceRoots: string[] = [];
vi.mock("../src/prWorkspace/gitCredentials.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prWorkspace/gitCredentials.ts")>();
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
import {
  prepareLocalPrWorkspace,
  workspaceCheckoutTelemetryFromError,
} from "../src/prWorkspace/localPrWorkspace.ts";
import {
  assertWorkspacePath,
  buildCheckoutCoverage,
  runWorkspaceGit,
} from "../src/prWorkspace/repositoryReader.ts";
import * as symbolIndexModule from "../src/prWorkspace/symbolIndex.ts";

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
        const mappedFiles = {
          ...prFiles,
          files: [
            ...prFiles.files,
            {
              filename: ".pr-agent/from-rename.mdc",
              status: "renamed",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
            {
              filename: ".pr-agent/from-copy.mdc",
              status: "copied",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ],
        };
        const fullWorkspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused",
          prFiles: mappedFiles,
          repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
          remoteUrlOverride: remote,
        });
        try {
          expect(fullWorkspace.reader.checkoutMode).toBe("full");
          expect(fullWorkspace.reader.changedFiles.map((file) => file.path).toSorted()).toEqual([
            ".pr-agent/from-copy.mdc",
            ".pr-agent/from-rename.mdc",
            "renamed.txt",
            "src.txt",
          ]);
          expect(
            fullWorkspace.reader.changedFiles.find(
              (file) => file.path === ".pr-agent/from-rename.mdc",
            ),
          ).toEqual({ path: ".pr-agent/from-rename.mdc", status: "renamed" });
          expect(
            fullWorkspace.reader.changedFiles.find(
              (file) => file.path === ".pr-agent/from-copy.mdc",
            ),
          ).toEqual({ path: ".pr-agent/from-copy.mdc", status: "copied" });
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

  it("binds policy files from the base commit and drops paths that are not regular allowlisted files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-policy-snapshot-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    try {
      await git(root, ["init", repo]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await mkdir(join(repo, ".pr-agent"));
      await mkdir(join(repo, ".PR-AGENT"));
      await writeFile(join(repo, ".pr-agent", "ok.mdc"), "base rule\n");
      await writeFile(join(repo, ".pr-agent", "big.mdc"), "b".repeat(8193));
      await writeFile(join(repo, "AGENTS.md"), "a".repeat(8973));
      await writeFile(join(repo, "secret-target.txt"), "secret-target-body\n");
      await symlink("../secret-target.txt", join(repo, ".pr-agent", "link.mdc"));
      await writeFile(join(repo, ".PR-AGENT", "x.mdc"), "wrong-case\n");
      await writeFile(join(repo, "src.txt"), "one\n");
      await writeFile(join(root, "odd.txt"), "odd\n");
      const oddBlob = await git(repo, ["hash-object", "-w", join(root, "odd.txt")]);
      await git(repo, ["add", "."]);
      await git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${oddBlob},.pr-agent//x.mdc`,
      ]).catch(() => "");
      await git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${oddBlob},.pr-agent\\x.mdc`,
      ]).catch(() => "");
      await git(repo, ["commit", "-m", "base"]);
      const baseSha = await git(repo, ["rev-parse", "HEAD"]);

      await writeFile(join(repo, ".pr-agent", "ok.mdc"), "head rule\n");
      await writeFile(join(repo, "src.txt"), "one\ntwo\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "head"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);

      await git(root, ["init", "--bare", remote]);
      await git(remote, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
      await git(repo, ["remote", "add", "origin", remote]);
      await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);
      const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);

      const workspace = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        baseSha,
        installationToken: "unused",
        prFiles,
        remoteUrlOverride: remote,
      });
      try {
        expect(workspace.policySnapshot.kind).toBe("ok");
        if (workspace.policySnapshot.kind !== "ok") return;
        expect(workspace.policySnapshot.baseSha).toBe(baseSha);
        const byPath = new Map(
          workspace.policySnapshot.files.map((file) => [file.path, file.body]),
        );
        expect(byPath.get(".pr-agent/ok.mdc")).toBe("base rule\n");
        expect(byPath.get("AGENTS.md")).toHaveLength(8973);
        expect([...byPath.values()].join("\n")).not.toContain("head rule");
        expect([...byPath.values()].join("\n")).not.toContain("secret-target-body");
        expect([...byPath.values()].join("\n")).not.toContain("wrong-case");
        expect(byPath.has(".pr-agent/big.mdc")).toBe(false);
        expect(byPath.has(".pr-agent/link.mdc")).toBe(false);
        expect(byPath.has(".PR-AGENT/x.mdc")).toBe(false);
        expect(byPath.has(".pr-agent//x.mdc")).toBe(false);
        expect(byPath.has(".pr-agent\\x.mdc")).toBe(false);
        expect(workspace.policySnapshot.drops).toEqual(
          expect.arrayContaining([
            { path: ".pr-agent/big.mdc", reason: "over_cap" },
            { path: ".pr-agent/link.mdc", reason: "non_regular_mode" },
          ]),
        );
        expect(await readFile(join(workspace.agentCwd, "src.txt"), "utf8")).toContain("two");
      } finally {
        await workspace.cleanup();
      }

      const missing = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        baseSha: "f".repeat(40),
        installationToken: "unused",
        prFiles,
        remoteUrlOverride: remote,
      });
      try {
        expect(missing.policySnapshot).toEqual({
          kind: "unavailable",
          reason: "fetch_failed",
          baseSha: "f".repeat(40),
        });
        expect(JSON.stringify(missing.policySnapshot)).not.toContain("head rule");
        expect(await readFile(join(missing.agentCwd, ".pr-agent", "ok.mdc"), "utf8")).toBe(
          "head rule\n",
        );
      } finally {
        await missing.cleanup();
      }

      const omitted = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        installationToken: "unused",
        prFiles,
        remoteUrlOverride: remote,
      });
      try {
        expect(omitted.policySnapshot).toEqual({
          kind: "unavailable",
          reason: "missing_base_sha",
        });
      } finally {
        await omitted.cleanup();
      }

      expect(isAllowlistedPolicyPath(".PR-AGENT/x.mdc")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent//x.mdc")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent\\x.mdc")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent/sub/x.mdc")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent/.hidden.mdc")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent/x.MDC")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent/x.mdc ")).toBe(false);
      expect(isAllowlistedPolicyPath("agENTS.md")).toBe(false);
      expect(isAllowlistedPolicyPath(".pr-agent/ok.mdc")).toBe(true);
      expect(isAllowlistedPolicyPath("AGENTS.md")).toBe(true);
      expect(isAllowlistedPolicyPath("CLAUDE.md")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("marks an over-cap object store, an empty allowlist, and a failed blob read", async () => {
    const baseSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const tree = `100644 blob ${blobSha}\t.pr-agent/ok.mdc\0`;
    const git = (script: (command: string) => { readonly stdout: string } | Promise<never>) => {
      return async (args: readonly string[]) => {
        const command = args.includes("fetch") ? "fetch" : (args[0] ?? "");
        return script(command);
      };
    };

    const overCap = await readBasePolicySnapshot({
      baseSha,
      maxFetchBytes: 1,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch" || command === "ls-tree") {
          return { stdout: command === "ls-tree" ? tree : "" };
        }
        if (command === "cat-file") return { stdout: "4\n" };
        if (command === "count-objects") return { stdout: "size: 2\nsize-pack: 0\n" };
        throw new Error(command);
      }),
    });
    expect(overCap).toEqual({ kind: "unavailable", reason: "object_store_cap", baseSha });

    const absent = await readBasePolicySnapshot({
      baseSha,
      maxFetchBytes: 1_000_000,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch" || command === "ls-tree") return { stdout: "" };
        if (command === "count-objects") return { stdout: "size: 0\nsize-pack: 0\n" };
        throw new Error(command);
      }),
    });
    expect(absent).toEqual({ kind: "absent", baseSha });

    const failed = await readBasePolicySnapshot({
      baseSha,
      maxFetchBytes: 1_000_000,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch") return { stdout: "" };
        if (command === "ls-tree") return { stdout: tree };
        throw new Error("cat-file failed");
      }),
    });
    expect(failed).toEqual({ kind: "unavailable", reason: "blob_read_failed", baseSha });
  });
});

type GitHttpDecision =
  | "serve"
  | "hold"
  | { readonly status: number; readonly headers?: Record<string, string> };

type GitHttpRequestRecord = {
  readonly index: number;
  readonly method: string;
  readonly path: string;
  readonly at: number;
  closedAt: number | null;
};

type GitHttpServer = {
  readonly url: string;
  readonly requests: readonly GitHttpRequestRecord[];
  readonly close: () => Promise<void>;
};

function headerText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function serveGitHttpBackend(projectRoot: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const protocol = headerText(req.headers["git-protocol"]);
  const encoding = headerText(req.headers["content-encoding"]);
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: headerText(req.headers["content-type"]) ?? "",
      REMOTE_ADDR: "127.0.0.1",
      ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
      ...(encoding ? { HTTP_CONTENT_ENCODING: encoding } : {}),
    },
  });
  req.pipe(cgi.stdin);
  let pending = Buffer.alloc(0);
  let headersSent = false;
  cgi.stdout.on("data", (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) return;
    headersSent = true;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of pending.subarray(0, end).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(pending.subarray(end + 4));
  });
  cgi.stdout.on("end", () => res.end());
  cgi.on("error", () => res.destroy());
}

async function startGitHttpServer(
  projectRoot: string,
  decide: (index: number) => GitHttpDecision,
): Promise<GitHttpServer> {
  const requests: GitHttpRequestRecord[] = [];
  const server = createServer((req, res) => {
    const record: GitHttpRequestRecord = {
      index: requests.length,
      method: req.method ?? "",
      path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
      at: performance.now(),
      closedAt: null,
    };
    requests.push(record);
    req.socket.once("close", () => {
      record.closedAt = performance.now();
    });
    const decision = decide(record.index);
    if (decision === "hold") return;
    if (decision === "serve") {
      serveGitHttpBackend(projectRoot, req, res);
      return;
    }
    res.writeHead(decision.status, decision.headers);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${address.port}/remote.git`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function makeHttpPrRemote(root: string): Promise<{
  readonly headSha: string;
  readonly prFiles: ListPullRequestFilesResult;
}> {
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await git(root, ["init", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "src.txt"), "one\n");
  await writeFile(join(repo, "support.txt"), "helper\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "src.txt"), "one\ntwo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "head"]);
  const headSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", remote]);
  await git(remote, ["config", "uploadpack.allowFilter", "true"]);
  await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(repo, ["push", remote, "HEAD:refs/pull/1/head"]);
  return { headSha, prFiles: await buildPrFilesFromRepo(repo, baseSha, headSha) };
}

function isLiveProcess(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

function appErrorOf(error: unknown): AppError {
  if (!isAppError(error)) throw new Error(`expected AppError, got ${String(error)}`);
  return error;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

const FETCH_PROOF_PATH = process.env.PR_AGENT_WORKSPACE_FETCH_PROOF;
const LOW_SPEED_PROBE = process.env.PR_AGENT_GIT_LOW_SPEED_PROBE === "1";
const fetchProof: Record<string, unknown> = {};

describe("workspace git fetch over HTTP", () => {
  const shimRoot = mkdtempSync(join(tmpdir(), "workspace-git-shim-"));
  const shimLog = join(shimRoot, "invocations.log");
  const originalPath = process.env.PATH ?? "";
  const testTimeoutMs = 30_000;

  beforeAll(() => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(shimRoot, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${shimRoot}:${originalPath}`;
  });

  beforeEach(() => {
    writeFileSync(shimLog, "");
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    rmSync(shimRoot, { recursive: true, force: true });
  });

  function fetchInvocations(): string[] {
    return readFileSync(shimLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("-c core.hooksPath=/dev/null") && / fetch /.test(line));
  }

  it(
    "falls back to sparse in the same attempt after a silent full fetch times out",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-silent-fetch-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, (index) => (index === 0 ? "hold" : "serve"));
      try {
        const workspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "ghs_SYNTHETICSILENTFETCHTOKEN0000000000",
          prFiles,
          remoteUrlOverride: server.url,
          fetchTimeoutMs: 1_500,
        });
        try {
          const telemetry = workspace.checkoutTelemetry;
          expect(telemetry.mode).toBe("sparse_fallback");
          expect(telemetry.fallbackReason).toBe("fetch_timeout");
          expect(telemetry.fetchAttempts).toHaveLength(2);
          const [full, sparse] = telemetry.fetchAttempts;
          expect(full).toMatchObject({
            checkoutMode: "full",
            outcome: "failed",
            errorCode: "pr_workspace.fetch_timeout",
            failureKind: "timeout",
            timeoutSource: "process_timer",
            exitCode: null,
            signal: "SIGTERM",
            killed: true,
          });
          expect(full?.elapsedMs).toBeGreaterThanOrEqual(1_500);
          expect(full?.elapsedMs).toBeLessThan(1_500 + 2_000 + 2_000);
          expect(sparse).toMatchObject({
            checkoutMode: "sparse",
            outcome: "succeeded",
            exitCode: 0,
            signal: null,
            killed: false,
            timeoutSource: null,
          });

          const held = server.requests[0];
          const firstSparseRequest = server.requests.find(
            (request) => request.index > 0 && request.method === "GET",
          );
          expect(held?.closedAt).not.toBeNull();
          expect(firstSparseRequest).toBeDefined();
          expect(held?.closedAt ?? Infinity).toBeLessThanOrEqual(firstSparseRequest?.at ?? 0);

          const fetches = fetchInvocations();
          expect(fetches).toHaveLength(2);
          expect(fetches[0]).not.toContain("--filter=blob:none");
          expect(fetches[0]).toContain("http.lowSpeedLimit=1000");
          expect(fetches[0]).toContain("http.lowSpeedTime=20");
          expect(fetches[1]).toContain("--filter=blob:none");
          expect(fetches[1]).toContain("http.lowSpeedLimit=1000");

          expect(workspace.reader.checkoutMode).toBe("sparse");
          expect(workspace.reader.getCoverage()).toMatchObject({ mode: "sparse" });
          expect(await readFile(join(workspace.agentCwd, "src.txt"), "utf8")).toContain("two");
          expect(workspace.reader.checkoutPaths.has("support.txt")).toBe(false);
          await expect(readFile(join(workspace.agentCwd, "support.txt"), "utf8")).rejects.toThrow();

          const properties = workspaceCheckoutProperties({ telemetry, reused: false });
          expect(properties).toMatchObject({
            workspace_checkout_mode: "sparse_fallback",
            workspace_fallback_reason: "fetch_timeout",
            workspace_checkout_reused: false,
            git_operation: "fetch",
            git_exit_code: 0,
            git_signal: null,
            git_killed: false,
            git_timeout_source: null,
            fallback_git_error_code: "pr_workspace.fetch_timeout",
            fallback_git_error_kind: "timeout",
            fallback_git_exit_code: null,
            fallback_git_signal: "SIGTERM",
            fallback_git_killed: true,
            fallback_git_timeout_source: "process_timer",
          });
          expect(JSON.stringify(telemetry)).not.toContain("SYNTHETICSILENTFETCHTOKEN");

          const spans: Array<Record<string, unknown>> = [];
          const drain = initTraces(
            makeTestConfig({ runtime: { role: "worker" }, posthog: { projectToken: "phc" } }),
            {
              capture: (input) => spans.push(input.properties),
              flush: async () => undefined,
              shutdown: async () => undefined,
            },
          );
          await startWorkTrace(
            {
              executionId: "proof-execution",
              workItemId: "proof-work-item",
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha,
              installationId: 1,
              provider: "openai",
              model: "proof-model",
            },
            async () => annotateExecution({ extra: properties }),
          );
          await drain();
          const executionSpan = spans.find((span) => span.$ai_span_name === "execution");
          expect(executionSpan).toMatchObject({ status: "ok", ...properties });
          expect(executionSpan).not.toHaveProperty("$ai_error");

          fetchProof.silentFullFetchFallback = {
            telemetry,
            executionSpan,
            cleanup: {
              heldRequestClosedBeforeSparseFetch: true,
              heldRequestClosedAfterMs: Math.round((held?.closedAt ?? 0) - (held?.at ?? 0)),
              fetchInvocations: fetches.map((line) =>
                line.includes("--filter=blob:none") ? "sparse" : "full",
              ),
            },
            checkout: {
              readerCheckoutMode: workspace.reader.checkoutMode,
              coverage: workspace.reader.getCoverage(),
              changedFilePresent: true,
              unrelatedPathAbsent: true,
            },
          };
        } finally {
          await workspace.cleanup();
        }
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs,
  );

  it(
    "falls back to sparse after a generic Git transport failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-git-error-fetch-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, (index) =>
        index === 0 ? { status: 500 } : "serve",
      );
      try {
        const workspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused-token",
          prFiles,
          remoteUrlOverride: server.url,
        });
        try {
          expect(workspace.checkoutTelemetry.mode).toBe("sparse_fallback");
          expect(workspace.checkoutTelemetry.fallbackReason).toBe("git_failed");
          expect(workspace.checkoutTelemetry.fetchAttempts[0]).toMatchObject({
            checkoutMode: "full",
            outcome: "failed",
            errorCode: "pr_workspace.git_failed",
            failureKind: "git",
            exitCode: 128,
            signal: null,
            killed: false,
            timeoutSource: null,
          });
          expect(workspace.checkoutTelemetry.fetchAttempts[0]?.stderr).toContain(
            "returned error: 500",
          );
          expect(fetchInvocations()).toHaveLength(2);
          expect(await readFile(join(workspace.agentCwd, "src.txt"), "utf8")).toContain("two");
        } finally {
          await workspace.cleanup();
        }
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs,
  );

  it.each([
    {
      name: "auth denial",
      prNumber: 1,
      decide: (): GitHttpDecision => ({
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="git"' },
      }),
      failureKind: "auth",
      errorKind: "auth",
    },
    {
      name: "missing ref",
      prNumber: 2,
      decide: (): GitHttpDecision => "serve",
      failureKind: "missing_ref",
      errorKind: "not_found",
    },
  ])(
    "keeps $name terminal and never starts a sparse fallback",
    async ({ prNumber, decide, failureKind, errorKind }) => {
      const root = await mkdtemp(join(tmpdir(), "workspace-terminal-fetch-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, decide);
      try {
        const error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber,
              headSha,
              installationToken: "unused-token",
              prFiles,
              remoteUrlOverride: server.url,
            }),
          ),
        );
        expect(error.code).toBe("pr_workspace.git_failed");
        expect(error.context).toMatchObject({
          operation: "fetch",
          checkoutMode: "full",
          failureKind,
          exitCode: 128,
          signal: null,
          killed: false,
          timeoutSource: null,
        });
        expect(error.context).not.toHaveProperty("fallback");
        expect(retryDispositionFor(error)).toBe("terminal");
        expect(classifyFailure(error)).toMatchObject({ failureDomain: "internal", errorKind });
        expect(fetchInvocations()).toHaveLength(1);
        expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
          mode: "full",
          fetchAttempts: [{ checkoutMode: "full", outcome: "failed", failureKind }],
        });
        await expectAllocatedWorkspaceRootsRemoved();
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs,
  );

  it(
    "surfaces the sparse failure as primary when the fallback also fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-fallback-fail-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, (index) =>
        index === 0 ? "hold" : { status: 502 },
      );
      try {
        const error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha,
              installationToken: "unused-token",
              prFiles,
              remoteUrlOverride: server.url,
              fetchTimeoutMs: 1_000,
            }),
          ),
        );
        expect(error.code).toBe("pr_workspace.git_failed");
        expect(error.context).toMatchObject({
          operation: "fetch",
          checkoutMode: "sparse",
          failureKind: "git",
          exitCode: 128,
          timeoutSource: null,
          fallback: {
            checkoutMode: "full",
            errorCode: "pr_workspace.fetch_timeout",
            failureKind: "timeout",
            timeoutSource: "process_timer",
            signal: "SIGTERM",
            killed: true,
          },
        });
        expect(error.cause).toBeUndefined();
        expect(classifyFailure(error)).toMatchObject({
          failureDomain: "internal",
          errorKind: "git",
        });
        expect(classifyFailure(error)).not.toHaveProperty("timeoutSource");
        expect(retryDispositionFor(error)).toBe("transient");
        expect(fetchInvocations()).toHaveLength(2);
        expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
          mode: "sparse_fallback",
          fallbackReason: "fetch_timeout",
          fetchAttempts: [
            { checkoutMode: "full", outcome: "failed", errorCode: "pr_workspace.fetch_timeout" },
            { checkoutMode: "sparse", outcome: "failed", errorCode: "pr_workspace.git_failed" },
          ],
        });
        await expectAllocatedWorkspaceRootsRemoved();
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs,
  );

  it(
    "never creates a second fallback for an initially sparse checkout",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-sparse-fail-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, () => ({ status: 500 }));
      try {
        const error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha,
              installationToken: "unused-token",
              prFiles,
              repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB + 1,
              remoteUrlOverride: server.url,
            }),
          ),
        );
        expect(error.code).toBe("pr_workspace.git_failed");
        expect(error.context).toMatchObject({ checkoutMode: "sparse", failureKind: "git" });
        expect(error.context).not.toHaveProperty("fallback");
        const fetches = fetchInvocations();
        expect(fetches).toHaveLength(1);
        expect(fetches[0]).toContain("--filter=blob:none");
        expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
          mode: "sparse",
          fetchAttempts: [{ checkoutMode: "sparse", outcome: "failed" }],
        });
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs,
  );

  it.runIf(LOW_SPEED_PROBE)(
    "observes Git's own low-speed exit under the production fetch deadline",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-low-speed-"));
      const { headSha, prFiles } = await makeHttpPrRemote(root);
      const server = await startGitHttpServer(root, (index) => (index === 0 ? "hold" : "serve"));
      try {
        const workspace = await prepareLocalPrWorkspace({
          owner: "owner",
          repo: "repo",
          prNumber: 1,
          headSha,
          installationToken: "unused-token",
          prFiles,
          remoteUrlOverride: server.url,
        });
        try {
          const full = workspace.checkoutTelemetry.fetchAttempts[0];
          expect(workspace.checkoutTelemetry).toMatchObject({
            mode: "sparse_fallback",
            fallbackReason: "git_low_speed",
          });
          expect(full).toMatchObject({
            errorCode: "pr_workspace.git_failed",
            failureKind: "timeout",
            timeoutSource: "git_low_speed",
            exitCode: 128,
            killed: false,
          });
          expect(full?.stderr).toMatch(/Operation too slow/);
          expect(full?.elapsedMs).toBeLessThan(60_000);
          fetchProof.gitLowSpeedProbe = { telemetry: workspace.checkoutTelemetry };
        } finally {
          await workspace.cleanup();
        }
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

describe("workspace git process ownership", () => {
  it("escalates to SIGKILL for a descendant that ignores SIGTERM after its leader exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-tree-"));
    const pidFile = join(root, "helper.pid");
    try {
      const error = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(
            [
              "-c",
              `alias.stall=!sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' & sleep 0.2`,
              "stall",
            ],
            { cwd: root, timeoutMs: 600 },
          ),
        ),
      );
      const helperPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(helperPid) && helperPid > 0).toBe(true);
      expect(error.code).toBe("pr_workspace.git_failed");
      expect(error.context).toMatchObject({
        operation: "other",
        failureKind: "timeout",
        timeoutSource: "process_timer",
        exitCode: 0,
        killed: true,
        cleanup: "complete",
      });
      expect(Number(error.context.elapsedMs)).toBeGreaterThanOrEqual(600 + 2_000);
      expect(isLiveProcess(helperPid)).toBe(false);
      fetchProof.processTree = {
        context: error.context,
        helperLiveAfterSettlement: isLiveProcess(helperPid),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reports spawn failures without a timeout or fallback-eligible kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-spawn-fail-"));
    try {
      const error = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(["status"], {
            cwd: root,
            processCwd: join(root, "missing"),
            timeoutMs: 1_000,
          }),
        ),
      );
      expect(error.code).toBe("pr_workspace.git_failed");
      expect(error.context).toMatchObject({
        operation: "status",
        spawnErrorCode: "ENOENT",
        exitCode: null,
        signal: null,
        killed: false,
        timeoutSource: null,
        failureKind: "git",
      });
      expect(error.cause).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles exactly once when the deadline races process exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-race-"));
    try {
      for (const timeoutMs of [1, 2, 5, 10, 20, 40, 80]) {
        const error = appErrorOf(
          await rejectionOf(
            runWorkspaceGit(["-c", "alias.quick=!exit 3", "quick"], { cwd: root, timeoutMs }),
          ),
        );
        expect(error.code).toBe("pr_workspace.git_failed");
        if (error.context.timeoutSource === "process_timer") {
          expect(error.context).toMatchObject({ failureKind: "timeout", killed: true });
        } else {
          expect(error.context).toMatchObject({
            failureKind: "git",
            exitCode: 3,
            killed: false,
            timeoutSource: null,
          });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets split across stream chunks and diagnostic cut boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-redaction-"));
    const secret = "SYNTHETICSECRETVALUE0123456789abcdefXYZ";
    const head = secret.slice(0, 17);
    const tail = secret.slice(17);
    try {
      const split = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(
            [
              "-c",
              `alias.leak=!printf 'fatal: prefix ${head}' >&2; sleep 0.1; printf '${tail} https://x-access-token:${secret}@example.invalid/r.git\\n' >&2; printf '%0990d' 0 >&2; exit 1`,
              "leak",
            ],
            { cwd: root, timeoutMs: 5_000, redactSecrets: [secret] },
          ),
        ),
      );
      const limited = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(
            ["-c", `alias.cut=!printf 'fatal: partial ${secret}' >&2; sleep 1`, "cut"],
            { cwd: root, timeoutMs: 5_000, redactSecrets: [secret], maxBufferBytes: 30 },
          ),
        ),
      );
      const classified = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(
            [
              "-c",
              "alias.denied=!printf 'fatal: Authentication failed for x\\n' >&2; head -c 3000 /dev/zero | tr '\\0' 'n' >&2; exit 128",
              "denied",
            ],
            { cwd: root, timeoutMs: 5_000 },
          ),
        ),
      );
      expect(limited.context).toMatchObject({ outputLimited: true, failureKind: "git" });
      expect(classified.context.failureKind).toBe("auth");
      expect(String(classified.context.stderr)).not.toContain("Authentication failed");
      for (const error of [split, limited, classified]) {
        expect(String(error.context.stderr).length).toBeLessThanOrEqual(1_000);
        expect(error.cause).toBeUndefined();
        const serialized = [
          JSON.stringify(serializeAppError(error)),
          JSON.stringify(classifyFailure(error)),
          error.message,
          String(error),
        ].join("\n");
        for (const fragment of [secret, head, tail, secret.slice(0, 10), secret.slice(-10)]) {
          expect(serialized).not.toContain(fragment);
        }
        expect(serialized).not.toContain("x-access-token:");
        expect(serialized).not.toContain("alias.");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

afterAll(async () => {
  if (FETCH_PROOF_PATH) {
    await mkdir(dirname(FETCH_PROOF_PATH), { recursive: true });
    await writeFile(
      FETCH_PROOF_PATH,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          reproduce: `PR_AGENT_WORKSPACE_FETCH_PROOF=${FETCH_PROOF_PATH}${LOW_SPEED_PROBE ? " PR_AGENT_GIT_LOW_SPEED_PROBE=1" : ""} npm run test -- test/localPrWorkspace.test.ts`,
          gitVersion: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
          ...fetchProof,
        },
        null,
        2,
      )}\n`,
    );
  }
});
