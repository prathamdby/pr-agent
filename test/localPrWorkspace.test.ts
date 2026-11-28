import { ChildProcess, execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { AppError, isAppError, serializeAppError } from "../src/errors/appError.ts";
import { classifyFailure } from "../src/errors/classifiedFailure.ts";
import { retryDispositionFor } from "../src/agentWork/retryPolicy.ts";
import { annotateExecution, initTraces, startWorkTrace } from "../src/traces/recorder.ts";
import { workspaceCheckoutProperties } from "../src/prWorkspace/checkoutTelemetry.ts";
import { runGitProcess } from "../src/prWorkspace/gitProcess.ts";
import {
  assertObjectStoreWithinCap,
  enforceObjectStoreByteCap,
  objectStoreAllocatedBytes as scanObjectStoreAllocatedBytes,
} from "../src/prWorkspace/objectStoreBytes.ts";
import { readBasePolicySnapshot } from "../src/prWorkspace/policySnapshot.ts";
import { makeTestConfig } from "./helpers/config.ts";

const credentialHooks = { failAfterWrite: false };
const allocatedWorkspaceRoots: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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
import { buildWorkspaceTools } from "../src/agent/tools/workspaceToolset.ts";
import { createEvidenceLedger } from "../src/review/findings/evidenceLedger.ts";
import {
  assertWorkspacePath,
  buildCheckoutCoverage,
  gitGrepWorkspace,
  runWorkspaceGit,
} from "../src/prWorkspace/repositoryReader.ts";
import * as symbolIndexModule from "../src/prWorkspace/symbolIndex.ts";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: readonly string[]) {
  const { stdout } = await execFile("git", args, { cwd });
  return ((pinnedReturn: string | Promise<string>) => pinnedReturn)(stdout.trim());
}

async function expectAllocatedWorkspaceRootsRemoved() {
  expect(allocatedWorkspaceRoots).not.toEqual([]);
  await Promise.all(
    allocatedWorkspaceRoots.map((rootDir) =>
      expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" }),
    ),
  );
}

async function objectStoreAllocatedBytes(objectsDir: string) {
  const entries = await readdir(objectsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  });
  if (entries == null) return 0;
  let total = 0;
  for (const entry of entries) {
    const full = join(objectsDir, entry.name);
    if (entry.isDirectory()) {
      total += await objectStoreAllocatedBytes(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(full).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return null;
      }
      throw error;
    });
    if (info == null) continue;
    total += info.blocks > 0 ? info.blocks * 512 : info.size;
  }
  return total;
}

function watchWorkspaceObjectStores(objectsDirForRoot: (rootDir: string) => string) {
  let highWater = 0;
  let stopped = false;
  const loop = (async () => {
    while (true) {
      if (stopped) break;
      for (const rootDir of allocatedWorkspaceRoots) {
        const bytes = await objectStoreAllocatedBytes(objectsDirForRoot(rootDir)).catch(() => 0);
        highWater = Math.max(highWater, bytes);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    highWater: () => highWater,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

async function makeLargeBlobPrFixture(
  root: string,
  options: { readonly payloadBytes: number; readonly largeInBase: boolean },
) {
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await git(root, ["init", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "src.txt"), "one\n");
  if (options.largeInBase)
    await writeFile(join(repo, "huge.bin"), randomBytes(options.payloadBytes));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);

  if (!options.largeInBase) {
    await writeFile(join(repo, "huge.bin"), randomBytes(options.payloadBytes));
  }
  await writeFile(join(repo, "src.txt"), "one\ntwo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "head"]);
  const headSha = await git(repo, ["rev-parse", "HEAD"]);

  await git(root, ["init", "--bare", remote]);
  await git(remote, ["config", "uploadpack.allowFilter", "true"]);
  await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

  return {
    repo,
    remote,
    baseSha,
    headSha,
    prFiles: await buildPrFilesFromRepo(repo, baseSha, headSha),
  };
}

async function buildPrFilesFromRepo(repo: string, baseSha: string, headSha: string) {
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

  return ((pinnedReturn: ListPullRequestFilesResult | Promise<ListPullRequestFilesResult>) =>
    pinnedReturn)({ files, truncated: false, omittedCountLowerBound: 0, totalChanges });
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

  it("uses full checkout below the repo size cap and sparse checkout above it", async () => {
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
          fullWorkspace.reader.changedFiles.find((file) => file.path === ".pr-agent/from-copy.mdc"),
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
        expect(() => assertWorkspacePath(fullWorkspace.agentCwd, "../escape")).toThrow(/traversal/);
        expect(assertWorkspacePath(fullWorkspace.agentCwd, "..\\escape")).toBe(
          join(fullWorkspace.agentCwd, "..\\escape"),
        );
        expect(assertWorkspacePath(fullWorkspace.agentCwd, "\\etc\\passwd")).toBe(
          join(fullWorkspace.agentCwd, "\\etc\\passwd"),
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
        expect(await readFile(join(sparseWorkspace.agentCwd, "src.txt"), "utf8")).toContain("two");
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
  });

  it("terminates oversized full fetches at the byte ceiling and cleans up the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-fetch-cap-"));
    try {
      const payloadBytes = 24 * 1024 * 1024;
      const capBytes = 1024 * 1024;
      const fixture = await makeLargeBlobPrFixture(root, { payloadBytes, largeInBase: false });
      const watcher = watchWorkspaceObjectStores((rootDir) => join(rootDir, "private", "objects"));
      let error: AppError;
      try {
        error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha: fixture.headSha,
              installationToken: "unused",
              prFiles: fixture.prFiles,
              remoteUrlOverride: fixture.remote,
              maxFetchBytes: capBytes,
            }),
          ),
        );
      } finally {
        await watcher.stop();
      }

      expect(error.code).toBe("pr_workspace.fetch_too_large");
      expect(watcher.highWater()).toBeGreaterThan(0);
      expect(watcher.highWater()).toBeLessThan(8 * 1024 * 1024);
      expect(watcher.highWater()).toBeLessThan(payloadBytes / 2);
      expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
        mode: "sparse_fallback",
        fallbackReason: "fetch_too_large",
        fetchAttempts: [
          { checkoutMode: "full", outcome: "failed", errorCode: "pr_workspace.fetch_too_large" },
          { checkoutMode: "sparse", outcome: "failed", errorCode: "pr_workspace.fetch_too_large" },
        ],
      });
      expect(retryDispositionFor(error)).toBe("terminal");
      fetchProof.fullFetchByteCap = {
        transport: "local-path",
        payloadBytes,
        capBytes,
        highWaterBytes: watcher.highWater(),
        errorCode: error.code,
        telemetry: workspaceCheckoutTelemetryFromError(error),
      };
      await expectAllocatedWorkspaceRootsRemoved();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses sparse fallback when a full fetch crosses the byte ceiling for unselected blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-fetch-cap-fallback-"));
    try {
      const fixture = await makeLargeBlobPrFixture(root, {
        payloadBytes: 24 * 1024 * 1024,
        largeInBase: true,
      });
      const workspace = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha: fixture.headSha,
        installationToken: "unused",
        prFiles: fixture.prFiles,
        remoteUrlOverride: fixture.remote,
        maxFetchBytes: 1024 * 1024,
      });
      try {
        expect(workspace.checkoutTelemetry).toMatchObject({
          mode: "sparse_fallback",
          fallbackReason: "fetch_too_large",
          fetchAttempts: [
            { checkoutMode: "full", outcome: "failed", errorCode: "pr_workspace.fetch_too_large" },
            { checkoutMode: "sparse", outcome: "succeeded" },
          ],
        });
        expect(workspace.reader.checkoutMode).toBe("sparse");
        expect(await readFile(join(workspace.agentCwd, "src.txt"), "utf8")).toContain("two");
        await expect(readFile(join(workspace.agentCwd, "huge.bin"))).rejects.toThrow();
        expect(workspace.reader.checkoutPaths.has("huge.bin")).toBe(false);
        fetchProof.fullCapSparseFallback = {
          telemetry: workspace.checkoutTelemetry,
          coverage: workspace.reader.getCoverage(),
        };
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the sparse fallback when a changed path cannot be encoded", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-fallback-refused-"));
    try {
      const fixture = await makeLargeBlobPrFixture(root, {
        payloadBytes: 24 * 1024 * 1024,
        largeInBase: true,
      });
      const prFiles: ListPullRequestFilesResult = {
        ...fixture.prFiles,
        files: [
          ...fixture.prFiles.files,
          {
            filename: "line\nbreak",
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ],
      };
      const error = appErrorOf(
        await rejectionOf(
          prepareLocalPrWorkspace({
            owner: "owner",
            repo: "repo",
            prNumber: 1,
            headSha: fixture.headSha,
            installationToken: "unused",
            prFiles,
            remoteUrlOverride: fixture.remote,
            maxFetchBytes: 1024 * 1024,
          }),
        ),
      );
      expect(error.code).toBe("pr_workspace.fetch_too_large");
      const telemetry = workspaceCheckoutTelemetryFromError(error);
      expect(telemetry).toMatchObject({
        mode: "full",
        fallbackReason: null,
        fetchAttempts: [{ checkoutMode: "full", outcome: "failed" }],
      });
      expect(telemetry?.fetchAttempts).toHaveLength(1);
      fetchProof.unrepresentableSparseFallbackRefused = {
        errorCode: error.code,
        telemetry,
      };
      await expectAllocatedWorkspaceRootsRemoved();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes every encodable hostile filename byte-exact in a sparse checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-hostile-names-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const nfcCafe = "café-a".normalize("NFC");
    const nfdCafe = "café-a".normalize("NFD");
    const nfcResume = "résumé-b".normalize("NFC");
    const nfdResume = "résumé-b".normalize("NFD");
    try {
      await git(root, ["init", repo]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await mkdir(join(repo, "back"), { recursive: true });
      await mkdir(join(repo, "dir "), { recursive: true });
      await writeFile(join(repo, "back", "slash"), "decoy slash\n");
      await writeFile(join(repo, "starX"), "decoy star\n");
      await writeFile(join(repo, "qX"), "decoy q\n");
      await writeFile(join(repo, "bra"), "decoy bracket\n");
      await writeFile(join(repo, nfdCafe), "decoy cafe\n");
      await writeFile(join(repo, nfcResume), "decoy resume\n");
      await writeFile(join(repo, "support.txt"), "helper\n");
      await writeFile(join(repo, "gone.txt"), "gone\n");
      await writeFile(join(repo, "src.txt"), "one\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", "base"]);

      const headFiles: Readonly<Record<string, string>> = {
        "space ": "space-trail\n",
        "two  ": "two-spaces\n",
        "dir /nested.txt": "nested\n",
        "back\\slash": "backslash-needle\n",
        "endback\\": "endback\n",
        " lead": "lead-space\n",
        "!bang": "bang\n",
        "#hash": "hash\n",
        "cr\rmid": "cr-mid\n",
        "tab\t": "tab\n",
        "star*": "star\n",
        "q?": "q\n",
        "br[a]": "bracket\n",
        [nfcCafe]: "cafe\n",
        [nfdResume]: "resume\n",
      };
      for (const [name, content] of Object.entries(headFiles)) {
        await writeFile(join(repo, name), content);
      }
      await writeFile(join(repo, "src.txt"), "one\ntwo\n");
      await rm(join(repo, "gone.txt"));
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", "head"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);

      await git(root, ["init", "--bare", remote]);
      await git(remote, ["config", "uploadpack.allowFilter", "true"]);
      await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
      await git(repo, ["remote", "add", "origin", remote]);
      await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

      const changedPaths = [...Object.keys(headFiles), "src.txt"];
      const prFiles: ListPullRequestFilesResult = {
        files: [
          ...Object.keys(headFiles).map((filename) => ({
            filename,
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
          })),
          {
            filename: "src.txt",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: "gone.txt",
            status: "removed",
            additions: 0,
            deletions: 1,
            changes: 1,
          },
        ],
        truncated: false,
        omittedCountLowerBound: 0,
        totalChanges: changedPaths.length + 1,
      };
      const workspace = await prepareLocalPrWorkspace({
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
        expect(workspace.reader.checkoutMode).toBe("sparse");
        expect(workspace.checkoutTelemetry).toMatchObject({
          mode: "sparse",
          fallbackReason: null,
        });
        const sortedCheckoutPaths = [...workspace.reader.checkoutPaths].toSorted();
        expect(sortedCheckoutPaths).toEqual([...changedPaths].toSorted());
        fetchProof.hostileSparsePaths = {
          telemetry: workspace.checkoutTelemetry,
          checkoutPaths: sortedCheckoutPaths,
        };

        const evidenceLedger = createEvidenceLedger(headSha);
        const { executors } = buildWorkspaceTools(workspace.reader, {
          evidenceLedger,
          headSha,
        });
        const backslashRead = (await executors.readWorkspaceFile?.({
          path: "back\\slash",
        })) as { path?: string; content?: string };
        expect(backslashRead).toMatchObject({ path: "back\\slash" });
        expect(backslashRead.content).toContain("backslash-needle");
        expect(evidenceLedger.covers("back\\slash", 1, 1)).toBe(true);
        expect(evidenceLedger.covers("back/slash", 1, 1)).toBe(false);
        const decoyRead = (await executors.readWorkspaceFile?.({
          path: "back/slash",
        })) as { refused?: boolean };
        expect(decoyRead).toMatchObject({ refused: true });
        const search = (await executors.searchWorkspace?.({
          query: "backslash-needle",
        })) as { matches: { path: string }[] };
        expect(search.matches.map((match) => match.path)).toEqual(["back\\slash"]);
        const blame = (await executors.getWorkspaceBlame?.({
          path: "back\\slash",
        })) as { path?: string; blame?: string | null };
        expect(blame).toMatchObject({ path: "back\\slash" });
        expect(blame.blame?.length ?? 0).toBeGreaterThan(0);
        const spaceRead = (await executors.readWorkspaceFile?.({
          path: "space ",
        })) as { content?: string };
        expect(spaceRead.content).toContain("space-trail");

        const verification = buildWorkspaceTools({
          profile: "verification",
          reader: workspace.reader,
        });
        const verificationRead = (await verification.executors.readWorkspaceFile({
          path: "back\\slash",
        })) as { path?: string; content?: string };
        expect(verificationRead).toMatchObject({ path: "back\\slash" });
        expect(verificationRead.content).toContain("backslash-needle");
        const verificationSearch = (await verification.executors.searchWorkspace({
          query: "backslash-needle",
        })) as { matches: { path: string }[] };
        expect(verificationSearch.matches.map((match) => match.path)).toEqual(["back\\slash"]);
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a full checkout when a changed path cannot be encoded as a sparse pattern", async () => {
    const unrepresentableNames = ["line\nbreak", "trail\r"];
    const unrepresentableProof: {
      readonly name: string;
      readonly checkoutPaths: readonly string[];
    }[] = [];
    fetchProof.unrepresentableSparseFallback = unrepresentableProof;
    for (const hostileName of unrepresentableNames) {
      const root = await mkdtemp(join(tmpdir(), "workspace-unrepresentable-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "support.txt"), "helper\n");
        await writeFile(join(repo, "src.txt"), "one\n");
        await git(repo, ["add", "-A"]);
        await git(repo, ["commit", "-m", "base"]);

        await writeFile(join(repo, hostileName), "hostile\n");
        await writeFile(join(repo, "src.txt"), "one\ntwo\n");
        await git(repo, ["add", "-A"]);
        await git(repo, ["commit", "-m", "head"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await git(root, ["init", "--bare", remote]);
        await git(remote, ["config", "uploadpack.allowFilter", "true"]);
        await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/pull/1/head"]);

        const prFiles: ListPullRequestFilesResult = {
          files: [
            {
              filename: hostileName,
              status: "added",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
            {
              filename: "src.txt",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ],
          truncated: false,
          omittedCountLowerBound: 0,
          totalChanges: 2,
        };
        const workspace = await prepareLocalPrWorkspace({
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
          expect(workspace.checkoutTelemetry).toMatchObject({
            mode: "full_fallback",
            fallbackReason: "unrepresentable_path",
            fetchAttempts: [{ checkoutMode: "full", outcome: "succeeded" }],
          });
          expect(workspace.checkoutTelemetry.fetchAttempts).toHaveLength(1);
          expect(workspace.reader.checkoutMode).toBe("full");
          expect(workspace.reader.checkoutPaths.has(hostileName)).toBe(true);
          expect(workspace.reader.checkoutPaths.has("support.txt")).toBe(true);
          const partialCloneFilter = await git(root, [
            "--git-dir",
            workspace.privateGitDir,
            "config",
            "--get",
            "remote.origin.partialclonefilter",
          ]).catch(() => "");
          expect(partialCloneFilter).toBe("");
          expect(
            workspaceCheckoutProperties({
              telemetry: workspace.checkoutTelemetry,
              reused: false,
            }),
          ).toMatchObject({
            workspace_checkout_mode: "full_fallback",
            workspace_fallback_reason: "unrepresentable_path",
          });
          unrepresentableProof.push({
            name: hostileName,
            checkoutPaths: [...workspace.reader.checkoutPaths].toSorted(),
          });
        } finally {
          await workspace.cleanup();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("terminates sparse checkout blob backfill at the byte ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-sparse-fetch-cap-"));
    try {
      const payloadBytes = 24 * 1024 * 1024;
      const capBytes = 1024 * 1024;
      const fixture = await makeLargeBlobPrFixture(root, { payloadBytes, largeInBase: false });
      const watcher = watchWorkspaceObjectStores((rootDir) => join(rootDir, "private", "objects"));
      let error: AppError;
      try {
        error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha: fixture.headSha,
              installationToken: "unused",
              prFiles: fixture.prFiles,
              repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB + 1,
              remoteUrlOverride: fixture.remote,
              maxFetchBytes: capBytes,
            }),
          ),
        );
      } finally {
        await watcher.stop();
      }

      expect(error.code).toBe("pr_workspace.fetch_too_large");
      expect(error.context).toMatchObject({
        operation: "checkout",
        signal: "SIGTERM",
        killed: true,
      });
      expect(watcher.highWater()).toBeGreaterThan(0);
      expect(watcher.highWater()).toBeLessThan(8 * 1024 * 1024);
      expect(watcher.highWater()).toBeLessThan(payloadBytes / 2);
      expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
        mode: "sparse",
        fallbackReason: null,
        fetchAttempts: [
          {
            checkoutMode: "sparse",
            outcome: "failed",
            errorCode: "pr_workspace.fetch_too_large",
            signal: "SIGTERM",
            killed: true,
          },
        ],
      });
      fetchProof.sparseBackfillByteCap = {
        transport: "local-path",
        payloadBytes,
        capBytes,
        highWaterBytes: watcher.highWater(),
        errorCode: error.code,
        telemetry: workspaceCheckoutTelemetryFromError(error),
      };
      await expectAllocatedWorkspaceRootsRemoved();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a symbol index for checkout paths and tolerates index build failure", async () => {
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
  });

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
      expect(isAllowlistedPolicyPath("REVIEW.md")).toBe(true);
      expect(isAllowlistedPolicyPath("review.md")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an empty allowlist and failed blob reads while cap errors stay fatal", async () => {
    const baseSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const tree = `100644 blob ${blobSha}\t.pr-agent/ok.mdc\0`;
    const git = (
      script: (
        command: string,
        args: readonly string[],
        io?: { readonly stdin?: Buffer | string; readonly extraEnv?: Record<string, string> },
      ) => { readonly stdout: string; readonly stdoutBuffer?: Buffer } | Promise<never>,
    ) => {
      return async (
        args: readonly string[],
        _timeoutMs?: number,
        io?: { readonly stdin?: Buffer | string; readonly extraEnv?: Record<string, string> },
      ) => {
        const command = args.includes("fetch")
          ? args.includes("--stdin")
            ? "prefetch"
            : "fetch"
          : args[0] === "cat-file"
            ? args.some((arg) => arg.startsWith("--batch-check"))
              ? "cat-file-check"
              : "cat-file-batch"
            : (args[0] ?? "");
        return script(command, args, io);
      };
    };

    const absentCalls: string[] = [];
    const absent = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: git((command) => {
        absentCalls.push(command);
        if (command === "fetch" || command === "ls-tree") return { stdout: "" };
        throw new Error(command);
      }),
    });
    expect(absent).toEqual({ kind: "absent", baseSha });
    expect(absentCalls).toEqual(["fetch", "ls-tree"]);

    const failedFetch = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch") throw new Error("fetch failed");
        throw new Error(command);
      }),
    });
    expect(failedFetch).toEqual({ kind: "unavailable", reason: "fetch_failed", baseSha });

    const capError = () =>
      new AppError({
        domain: "pr_workspace",
        kind: "fetch_too_large",
        message: "object store exceeds cap",
      });
    await expect(
      readBasePolicySnapshot({
        baseSha,
        timeoutMs: 1_000,
        git: git((command) => {
          if (command === "fetch") throw capError();
          throw new Error(command);
        }),
      }),
    ).rejects.toMatchObject({ code: "pr_workspace.fetch_too_large" });
    await expect(
      readBasePolicySnapshot({
        baseSha,
        timeoutMs: 1_000,
        git: git((command) => {
          if (command === "fetch") return { stdout: "" };
          if (command === "ls-tree") return { stdout: tree };
          if (command === "prefetch") throw capError();
          throw new Error(command);
        }),
      }),
    ).rejects.toMatchObject({ code: "pr_workspace.fetch_too_large" });
    await expect(
      readBasePolicySnapshot({
        baseSha,
        timeoutMs: 1_000,
        git: git((command) => {
          if (command === "fetch" || command === "prefetch") return { stdout: "" };
          if (command === "ls-tree") return { stdout: tree };
          if (command === "cat-file-check") throw capError();
          throw new Error(command);
        }),
      }),
    ).rejects.toMatchObject({ code: "pr_workspace.fetch_too_large" });
    await expect(
      readBasePolicySnapshot({
        baseSha,
        timeoutMs: 1_000,
        git: git((command) => {
          if (command === "fetch" || command === "prefetch") return { stdout: "" };
          if (command === "ls-tree") return { stdout: tree };
          if (command === "cat-file-check") return { stdout: `${blobSha} blob 3\n` };
          if (command === "cat-file-batch") throw capError();
          throw new Error(command);
        }),
      }),
    ).rejects.toMatchObject({ code: "pr_workspace.fetch_too_large" });

    const failedPrefetch = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch") return { stdout: "" };
        if (command === "ls-tree") return { stdout: tree };
        throw new Error("prefetch failed");
      }),
    });
    expect(failedPrefetch).toEqual({ kind: "unavailable", reason: "blob_read_failed", baseSha });

    const failed = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: git((command) => {
        if (command === "fetch" || command === "prefetch") return { stdout: "" };
        if (command === "ls-tree") return { stdout: tree };
        throw new Error("cat-file failed");
      }),
    });
    expect(failed).toEqual({ kind: "unavailable", reason: "blob_read_failed", baseSha });
  });

  it("prefetches unique blobs once and reads in-cap bodies under GIT_NO_LAZY_FETCH", async () => {
    const baseSha = "a".repeat(40);
    const sharedSha = "b".repeat(40);
    const smallSha = "c".repeat(40);
    const overSha = "d".repeat(40);
    const utfSha = "e".repeat(40);
    const utfBody = Buffer.from("café — → 日本語 🎯\n");
    const sharedBody = Buffer.from("s".repeat(9_000));
    const smallBody = Buffer.from("ok\n");
    const tree = [
      `100644 blob ${sharedSha}\t.pr-agent/shared.mdc`,
      `100644 blob ${sharedSha}\tAGENTS.md`,
      `100644 blob ${smallSha}\t.pr-agent/a.mdc`,
      `100644 blob ${smallSha}\t.pr-agent/z.mdc`,
      `100644 blob ${overSha}\t.pr-agent/big.mdc`,
      `100644 blob ${utfSha}\t.pr-agent/utf.mdc`,
      `120000 blob ${smallSha}\t.pr-agent/link.mdc`,
    ].join("\0");
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly stdin?: Buffer | string;
      readonly extraEnv?: Record<string, string>;
    }> = [];
    const snapshot = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: async (args, _timeoutMs, io) => {
        const command = args.includes("fetch")
          ? args.includes("--stdin")
            ? "prefetch"
            : "fetch"
          : (args[0] ?? "");
        calls.push({ command, args, stdin: io?.stdin, extraEnv: io?.extraEnv });
        if (command === "fetch") return { stdout: "" };
        if (command === "ls-tree") return { stdout: tree };
        if (command === "prefetch") {
          expect(args).toEqual(
            expect.arrayContaining([
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "--no-recurse-submodules",
              "origin",
              "--stdin",
            ]),
          );
          expect(args).not.toContain("--filter=blob:none");
          expect(io?.stdin).toBe(`${[sharedSha, smallSha, overSha, utfSha].join("\n")}\n`);
          return { stdout: "" };
        }
        if (command === "cat-file" && args.some((arg) => arg.startsWith("--batch-check="))) {
          expect(io?.extraEnv).toEqual({ GIT_NO_LAZY_FETCH: "1" });
          return {
            stdout: [
              `${sharedSha} blob 9000`,
              `${smallSha} blob 3`,
              `${overSha} blob 8193`,
              `${utfSha} blob ${utfBody.length}`,
              "",
            ].join("\n"),
          };
        }
        if (command === "cat-file" && args.includes("--batch")) {
          expect(io?.extraEnv).toEqual({ GIT_NO_LAZY_FETCH: "1" });
          expect(io?.stdin).toBe(`${[sharedSha, smallSha, utfSha].join("\n")}\n`);
          const chunks = [sharedBody, smallBody, utfBody].flatMap((body, index) => {
            const sha = [sharedSha, smallSha, utfSha][index] ?? "";
            return [Buffer.from(`${sha} blob ${body.length}\n`), body, Buffer.from("\n")];
          });
          return { stdout: "", stdoutBuffer: Buffer.concat(chunks) };
        }
        throw new Error(command);
      },
    });
    expect(snapshot).toEqual({
      kind: "ok",
      baseSha,
      files: [
        { path: ".pr-agent/a.mdc", blobSha: smallSha, body: "ok\n" },
        { path: ".pr-agent/utf.mdc", blobSha: utfSha, body: utfBody.toString("utf8") },
        { path: ".pr-agent/z.mdc", blobSha: smallSha, body: "ok\n" },
        { path: "AGENTS.md", blobSha: sharedSha, body: sharedBody.toString("utf8") },
      ],
      drops: [
        { path: ".pr-agent/big.mdc", reason: "over_cap" },
        { path: ".pr-agent/link.mdc", reason: "non_regular_mode" },
        { path: ".pr-agent/shared.mdc", reason: "over_cap" },
      ],
    });
    expect(calls.filter((call) => call.command === "prefetch")).toHaveLength(1);
    expect(calls.filter((call) => call.args[0] === "cat-file")).toHaveLength(2);
    expect(
      calls.filter((call) => call.args[0] === "cat-file").map((call) => call.extraEnv),
    ).toEqual([{ GIT_NO_LAZY_FETCH: "1" }, { GIT_NO_LAZY_FETCH: "1" }]);
  });

  it("skips blob fetch and cat-file when every allowlisted path is non-regular", async () => {
    const baseSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const commands: string[] = [];
    const snapshot = await readBasePolicySnapshot({
      baseSha,
      timeoutMs: 1_000,
      git: async (args) => {
        const command = args.includes("fetch")
          ? args.includes("--stdin")
            ? "prefetch"
            : "fetch"
          : (args[0] ?? "");
        commands.push(command);
        if (command === "fetch") return { stdout: "" };
        if (command === "ls-tree") {
          return { stdout: `120000 blob ${blobSha}\t.pr-agent/link.mdc\0` };
        }
        throw new Error(command);
      },
    });
    expect(snapshot).toEqual({
      kind: "ok",
      baseSha,
      files: [],
      drops: [{ path: ".pr-agent/link.mdc", reason: "non_regular_mode" }],
    });
    expect(commands).toEqual(["fetch", "ls-tree"]);
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

function headerText(value: string | string[] | undefined) {
  if (Array.isArray(value))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(value.join(","));
  return ((pinnedReturn: string | undefined) => pinnedReturn)(value);
}

function serveGitHttpBackend(projectRoot: string, req: IncomingMessage, res: ServerResponse) {
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

async function startGitHttpServer(projectRoot: string, decide: (index: number) => GitHttpDecision) {
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
  return ((pinnedReturn: GitHttpServer | Promise<GitHttpServer>) => pinnedReturn)({
    url: `http://127.0.0.1:${address.port}/remote.git`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

async function makeHttpPrRemote(root: string) {
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
  return ((
    pinnedReturn:
      | {
          readonly headSha: string;
          readonly prFiles: ListPullRequestFilesResult;
        }
      | Promise<{
          readonly headSha: string;
          readonly prFiles: ListPullRequestFilesResult;
        }>,
  ) => pinnedReturn)({ headSha, prFiles: await buildPrFilesFromRepo(repo, baseSha, headSha) });
}

function isLiveProcess(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return ((pinnedReturn: boolean) => pinnedReturn)(state !== "Z" && state !== "X");
  } catch {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
}

function appErrorOf(error: unknown) {
  if (!isAppError(error)) throw new Error(`expected AppError, got ${String(error)}`);
  return ((pinnedReturn: AppError) => pinnedReturn)(error);
}

async function rejectionOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return ((pinnedReturn: unknown | Promise<unknown>) => pinnedReturn)(error);
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

  function fetchInvocations() {
    return ((pinnedReturn: string[]) => pinnedReturn)(
      readFileSync(shimLog, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("-c core.hooksPath=/dev/null") && / fetch /.test(line)),
    );
  }

  it("falls back to sparse in the same attempt after a silent full fetch times out", async () => {
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
  });

  it("terminates an oversized smart-http fetch at the byte ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-http-fetch-cap-"));
    try {
      const payloadBytes = 24 * 1024 * 1024;
      const capBytes = 1024 * 1024;
      const fixture = await makeLargeBlobPrFixture(root, { payloadBytes, largeInBase: false });
      const server = await startGitHttpServer(root, () => "serve");
      const watcher = watchWorkspaceObjectStores((rootDir) => join(rootDir, "private", "objects"));
      let error: AppError;
      try {
        error = appErrorOf(
          await rejectionOf(
            prepareLocalPrWorkspace({
              owner: "owner",
              repo: "repo",
              prNumber: 1,
              headSha: fixture.headSha,
              installationToken: "unused-token",
              prFiles: fixture.prFiles,
              remoteUrlOverride: server.url,
              maxFetchBytes: capBytes,
            }),
          ),
        );
      } finally {
        await watcher.stop();
        await server.close();
      }

      expect(error.code).toBe("pr_workspace.fetch_too_large");
      expect(watcher.highWater()).toBeGreaterThan(0);
      expect(watcher.highWater()).toBeLessThan(8 * 1024 * 1024);
      expect(watcher.highWater()).toBeLessThan(payloadBytes / 2);
      expect(workspaceCheckoutTelemetryFromError(error)).toMatchObject({
        mode: "sparse_fallback",
        fallbackReason: "fetch_too_large",
        fetchAttempts: [
          { checkoutMode: "full", outcome: "failed", errorCode: "pr_workspace.fetch_too_large" },
          { checkoutMode: "sparse", outcome: "failed", errorCode: "pr_workspace.fetch_too_large" },
        ],
      });
      const fetches = fetchInvocations();
      expect(fetches).toHaveLength(2);
      expect(fetches[0]).not.toContain("--filter=blob:none");
      expect(fetches[1]).toContain("--filter=blob:none");
      fetchProof.smartHttpByteCap = {
        transport: "smart-http",
        payloadBytes,
        capBytes,
        highWaterBytes: watcher.highWater(),
        errorCode: error.code,
        telemetry: workspaceCheckoutTelemetryFromError(error),
        fetchInvocations: fetches.map((line) =>
          line.includes("--filter=blob:none") ? "sparse" : "full",
        ),
      };
      await expectAllocatedWorkspaceRootsRemoved();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to sparse after a generic Git transport failure", async () => {
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
  });

  it.each([
    {
      name: "auth denial",
      prNumber: 1,
      decide: () =>
        ((pinnedReturn: GitHttpDecision) => pinnedReturn)({
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        }),
      failureKind: "auth",
      errorKind: "auth",
    },
    {
      name: "missing ref",
      prNumber: 2,
      decide: () => ((pinnedReturn: GitHttpDecision) => pinnedReturn)("serve"),
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
  );

  it("surfaces the sparse failure as primary when the fallback also fails", async () => {
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
  });

  it("never creates a second fallback for an initially sparse checkout", async () => {
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
  });

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
  );

  it("keeps policy snapshot upload-pack POSTs constant as allowlisted files grow", async () => {
    const utfBody = "café — → 日本語 🎯\n";
    const sharedBody = "s".repeat(9_000);
    const duplicateBody = "same-blob\n";
    const counts: number[] = [];
    for (const ruleCount of [10, 18]) {
      const root = await mkdtemp(join(tmpdir(), `workspace-policy-http-${ruleCount}-`));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await mkdir(join(repo, ".pr-agent"));
        await writeFile(join(repo, ".pr-agent", "shared.mdc"), sharedBody);
        await writeFile(join(repo, "AGENTS.md"), sharedBody);
        await writeFile(join(repo, ".pr-agent", "big.mdc"), "b".repeat(8193));
        await writeFile(join(repo, "secret-target.txt"), "secret-target-body\n");
        await symlink("../secret-target.txt", join(repo, ".pr-agent", "link.mdc"));
        await writeFile(join(repo, ".pr-agent", "utf.mdc"), utfBody);
        await writeFile(join(repo, ".pr-agent", "dup-a.mdc"), duplicateBody);
        await writeFile(join(repo, ".pr-agent", "dup-z.mdc"), duplicateBody);
        for (let index = 0; index < ruleCount; index += 1) {
          await writeFile(
            join(repo, ".pr-agent", `rule-${String(index).padStart(2, "0")}.mdc`),
            `rule ${index}\n`,
          );
        }
        await writeFile(join(repo, "src.txt"), "one\n");
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
        const prFiles = await buildPrFilesFromRepo(repo, baseSha, headSha);
        const server = await startGitHttpServer(root, () => "serve");
        try {
          const workspace = await prepareLocalPrWorkspace({
            owner: "owner",
            repo: "repo",
            prNumber: 1,
            headSha,
            baseSha,
            installationToken: "unused",
            prFiles,
            remoteUrlOverride: server.url,
          });
          try {
            expect(workspace.policySnapshot.kind).toBe("ok");
            if (workspace.policySnapshot.kind !== "ok") return;
            const byPath = new Map(
              workspace.policySnapshot.files.map((file) => [file.path, file.body]),
            );
            expect(byPath.get("AGENTS.md")).toBe(sharedBody);
            expect(byPath.get(".pr-agent/utf.mdc")).toBe(utfBody);
            expect(byPath.get(".pr-agent/dup-a.mdc")).toBe(duplicateBody);
            expect(byPath.get(".pr-agent/dup-z.mdc")).toBe(duplicateBody);
            expect(byPath.has(".pr-agent/shared.mdc")).toBe(false);
            expect(byPath.has(".pr-agent/big.mdc")).toBe(false);
            expect(byPath.has(".pr-agent/link.mdc")).toBe(false);
            for (let index = 0; index < ruleCount; index += 1) {
              expect(byPath.get(`.pr-agent/rule-${String(index).padStart(2, "0")}.mdc`)).toBe(
                `rule ${index}\n`,
              );
            }
            expect(workspace.policySnapshot.files).toHaveLength(ruleCount + 4);
            expect(workspace.policySnapshot.drops).toEqual([
              { path: ".pr-agent/big.mdc", reason: "over_cap" },
              { path: ".pr-agent/link.mdc", reason: "non_regular_mode" },
              { path: ".pr-agent/shared.mdc", reason: "over_cap" },
            ]);
            const posts = server.requests.filter(
              (request) => request.method === "POST" && request.path.includes("git-upload-pack"),
            );
            expect(posts.length).toBeLessThan(ruleCount);
            counts.push(posts.length);
          } finally {
            await workspace.cleanup();
          }
        } finally {
          await server.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(counts).toHaveLength(2);
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeLessThanOrEqual(4);
  });
});

describe("workspace git process ownership", () => {
  it("swallows EPIPE when git exits before bounded stdin is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-stdin-epipe-"));
    try {
      const error = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(["-c", "alias.die=!exit 1", "die"], {
            cwd: root,
            timeoutMs: 5_000,
            stdin: Buffer.alloc(1_048_576, 0x61),
          }),
        ),
      );
      expect(error.code).toBe("pr_workspace.git_failed");
      expect(error.context).toMatchObject({
        operation: "other",
        failureKind: "git",
        exitCode: 1,
        killed: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
  });

  it("rejects a quick object write that finishes between monitor polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-quick-write-cap-"));
    try {
      await git(root, ["init"]);
      await writeFile(join(root, "new.txt"), "quick write\n");
      const error = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(["add", "new.txt"], {
            cwd: root,
            timeoutMs: 1_000,
            objectStoreByteLimit: {
              objectsDir: join(root, ".git", "objects"),
              maxBytes: 1,
            },
          }),
        ),
      );
      expect(error.code).toBe("pr_workspace.fetch_too_large");
      expect(error.context).toMatchObject({
        operation: "add",
        maxFetchBytes: 1,
      });
      expect(Number(error.context.objectStoreBytes)).toBeGreaterThan(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the object-store ceiling to no-match pinned grep execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-pinned-grep-cap-"));
    try {
      await git(root, ["init"]);
      await writeFile(join(root, "new.txt"), "pinned grep\n");
      await git(root, ["add", "new.txt"]);
      const error = appErrorOf(
        await rejectionOf(
          gitGrepWorkspace(
            { privateGitDir: join(root, ".git"), agentCwd: root },
            {
              query: "absent-no-match",
              maxResults: 10,
              timeoutMs: 1_000,
              objectStoreByteLimit: {
                objectsDir: join(root, ".git", "objects"),
                maxBytes: 1,
              },
            },
          ),
        ),
      );
      expect(error.code).toBe("pr_workspace.fetch_too_large");
      expect(error.context).toMatchObject({ operation: "grep", maxFetchBytes: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the object-store monitor cannot scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-monitor-error-"));
    const objectsDir = join(root, "objects");
    try {
      await mkdir(objectsDir);
      await chmod(objectsDir, 0);
      const error = appErrorOf(
        await rejectionOf(
          runWorkspaceGit(["grep", "definitely-not-present"], {
            cwd: process.cwd(),
            timeoutMs: 1_000,
            objectStoreByteLimit: { objectsDir, maxBytes: 1 },
          }),
        ),
      );
      expect(error.code).toBe("pr_workspace.git_failed");
      expect(error.code).not.toBe("pr_workspace.fetch_too_large");
      expect(error.context).toMatchObject({
        operation: "grep",
        objectStoreMonitorErrorCode: "EACCES",
      });
      expect(error.context.objectStoreBytes).toBeUndefined();
    } finally {
      await chmod(objectsDir, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts exactly capped and concurrently missing object stores", async () => {
    expect(() => assertObjectStoreWithinCap(1_024, 1_024)).not.toThrow();
    let overCapError: unknown;
    try {
      assertObjectStoreWithinCap(1_025, 1_024);
    } catch (error) {
      overCapError = error;
    }
    expect(overCapError).toMatchObject({
      code: "pr_workspace.fetch_too_large",
      context: { objectStoreBytes: 1_025, maxFetchBytes: 1_024 },
    });

    const root = await mkdtemp(join(tmpdir(), "workspace-missing-objects-"));
    const objectsDir = join(root, "objects");
    const missingDir = join(root, "missing");
    try {
      await mkdir(objectsDir);
      await writeFile(join(objectsDir, "object"), Buffer.alloc(4_096));
      const objectStoreBytes = await scanObjectStoreAllocatedBytes(objectsDir);
      expect(objectStoreBytes).toBeGreaterThan(0);
      await expect(
        enforceObjectStoreByteCap(objectsDir, objectStoreBytes),
      ).resolves.toBeUndefined();
      await expect(
        enforceObjectStoreByteCap(objectsDir, objectStoreBytes - 1),
      ).rejects.toMatchObject({
        code: "pr_workspace.fetch_too_large",
        context: { objectStoreBytes, maxFetchBytes: objectStoreBytes - 1 },
      });
      await expect(scanObjectStoreAllocatedBytes(missingDir)).resolves.toBe(0);
      await expect(enforceObjectStoreByteCap(missingDir, 1)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wraps post-hoc object-store measurement failures in workspace Git errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-posthoc-measure-error-"));
    const objectsDir = join(root, "objects");
    try {
      await mkdir(objectsDir);
      await chmod(objectsDir, 0);
      await expect(enforceObjectStoreByteCap(objectsDir, 1)).rejects.toMatchObject({
        code: "pr_workspace.git_failed",
        context: { objectStoreMonitorErrorCode: "EACCES", maxFetchBytes: 1 },
      });
    } finally {
      await chmod(objectsDir, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("completes cleanup without SIGKILL when the group exits after SIGTERM", async () => {
    const pid = 1234;
    const child = Object.assign(new ChildProcess(), { pid });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const kill = vi
      .spyOn(process, "kill")
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = runGitProcess(["status"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 10,
        maxBufferBytes: 1024,
      });

      await vi.advanceTimersToNextTimerAsync();
      expect(kill.mock.calls).toEqual([[-pid, "SIGTERM"]]);
      child.emit("exit", null, "SIGTERM");
      await vi.advanceTimersToNextTimerAsync();
      await expect(run).resolves.toMatchObject({
        signal: "SIGTERM",
        timedOut: true,
        killed: true,
        cleanup: "complete",
      });
      expect(kill.mock.calls).toEqual([
        [-pid, "SIGTERM"],
        [-pid, 0],
      ]);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
      vi.mocked(spawn).mockReset();
    }
  });

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

  it("scrubs secrets from the git child environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-git-env-"));
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    };
    process.env.DATABASE_URL = "postgres://synthetic:secret@127.0.0.1:5432/pr_agent";
    process.env.GITHUB_APP_PRIVATE_KEY = "synthetic-github-app-private-key";
    process.env.OPENAI_API_KEY = "sk-synthetic-openai-key";
    process.env.WEBHOOK_SECRET = "synthetic-webhook-secret";
    process.env.HTTPS_PROXY = "https://proxy.test.example";
    process.env.SSH_AUTH_SOCK = "/tmp/synthetic-ssh-agent.sock";
    try {
      const result = await runWorkspaceGit(["-c", "alias.dumpenv=!printenv", "dumpenv"], {
        cwd: root,
        timeoutMs: 5_000,
      });
      expect(result.stdout).toMatch(/^PATH=/m);
      expect(result.stdout).toContain("HTTPS_PROXY=https://proxy.test.example");
      expect(result.stdout).not.toContain("DATABASE_URL=");
      expect(result.stdout).not.toContain("GITHUB_APP_PRIVATE_KEY=");
      expect(result.stdout).not.toContain("OPENAI_API_KEY=");
      expect(result.stdout).not.toContain("WEBHOOK_SECRET=");
      expect(result.stdout).not.toContain("SSH_AUTH_SOCK=");
      expect(result.stdout).not.toContain("synthetic-github-app-private-key");
      expect(result.stdout).not.toContain("sk-synthetic-openai-key");
      expect(result.stdout).not.toContain("synthetic-webhook-secret");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
