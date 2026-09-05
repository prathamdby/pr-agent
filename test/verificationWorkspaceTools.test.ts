import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isTriageSearchPathAllowed } from "../src/agent/triage/triageWorkspaceTools.js";
import { buildVerificationWorkspaceTools } from "../src/agent/verification/verificationWorkspaceTools.js";
import type {
  ListPullRequestFilesResult,
  PullRequestFileEntry,
} from "../src/github/listPullRequestFiles.js";
import {
  prepareLocalPrWorkspace,
  type LocalPrWorkspace,
} from "../src/prWorkspace/localPrWorkspace.js";
import {
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const exec = promisify(execFile);
const WORKSPACE_TEST_TIMEOUT_MS = 20_000;

const APP_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1,2 @@",
  " export {};",
  "+export const needle = 1;",
].join("\n");

const GONE_PATCH = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const removed = true;",
].join("\n");

type SetupOptions = {
  readonly deletedFiles?: Readonly<Record<string, string>>;
  readonly patches?: Readonly<Record<string, string>>;
  readonly omittedPatchPaths?: readonly string[];
  readonly absentPatchPaths?: readonly string[];
};

async function writeTree(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

function prFileEntry(
  path: string,
  status: string,
  options: SetupOptions,
): PullRequestFileEntry | null {
  const omitted = options.omittedPatchPaths?.includes(path) === true;
  const absent = options.absentPatchPaths?.includes(path) === true;
  const patch = options.patches?.[path];
  if (patch == null && !omitted && !absent && status !== "removed") return null;
  return {
    filename: path,
    status,
    additions: status === "removed" ? 0 : 1,
    deletions: status === "removed" ? 1 : 0,
    changes: 1,
    ...(omitted ? { patchOmitted: true } : {}),
    ...(patch != null && !omitted ? { patch } : {}),
  };
}

describe("buildVerificationWorkspaceTools", { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  const sources: string[] = [];
  const workspaces: LocalPrWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
    await Promise.all(sources.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(files: Readonly<Record<string, string>>, options: SetupOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), "verification-ws-tools-"));
    sources.push(root);
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    await exec("git", ["init", repo]);
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repo });

    const deletedFiles = options.deletedFiles ?? {};
    if (Object.keys(deletedFiles).length > 0) {
      await writeTree(repo, { ...files, ...deletedFiles });
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "base"], { cwd: repo });
      for (const path of Object.keys(deletedFiles)) {
        await exec("git", ["rm", "-f", "--", path], { cwd: repo });
      }
      await writeTree(repo, files);
      await exec("git", ["add", "-A"], { cwd: repo });
      await exec("git", ["commit", "-m", "head"], { cwd: repo });
    } else {
      await writeTree(repo, files);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "head"], { cwd: repo });
    }

    const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
    await exec("git", ["push", "origin", "HEAD:refs/pull/1/head"], { cwd: repo });

    const prFilesList: PullRequestFileEntry[] = [];
    for (const path of Object.keys(files)) {
      const entry = prFileEntry(path, "modified", options);
      if (entry) prFilesList.push(entry);
    }
    for (const path of Object.keys(deletedFiles)) {
      const entry = prFileEntry(path, "removed", options);
      if (entry) prFilesList.push(entry);
    }
    const prFiles: ListPullRequestFilesResult = {
      files: prFilesList,
      truncated: false,
      omittedCountLowerBound: 0,
      totalChanges: prFilesList.length,
      headSha,
    };

    const workspace = await prepareLocalPrWorkspace({
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      headSha,
      installationToken: "unused",
      prFiles,
      remoteUrlOverride: remote,
    });
    workspaces.push(workspace);
    const { executors } = buildVerificationWorkspaceTools({
      cfg: makeTestConfig(),
      workspace,
    });
    return { root, repo, workspace, executors };
  }

  describe("readWorkspaceFile", () => {
    it("names a FIFO instead of reporting it missing", async () => {
      const { workspace, executors } = await setup({ "src/app.ts": "export {};\n" });
      await chmod(workspace.agentCwd, 0o755);
      await mkdir(join(workspace.agentCwd, "logs"), { recursive: true });
      await exec("mkfifo", [join(workspace.agentCwd, "logs", "live.pipe")]);

      const out = (await executors.readWorkspaceFile({ path: "logs/live.pipe" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toContain("FIFO");
      expect(out.reason).not.toContain("missing");
    });

    it("notes an empty file instead of returning silent empty content", async () => {
      const { executors } = await setup({ "src/empty.ts": "" });

      const out = (await executors.readWorkspaceFile({ path: "src/empty.ts" })) as {
        content?: string;
        note?: string;
        refused?: boolean;
      };

      expect(out.content).toBe("");
      expect(out.note).toBe("File is empty (0 bytes).");
      expect(out.refused).toBeUndefined();
    });

    it("reads regular files without a note", async () => {
      const { executors } = await setup({ "src/app.ts": "alpha\nbeta\n" });

      const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
        content?: string;
        note?: string;
      };

      expect(out.content).toBe("alpha\nbeta\n");
      expect(out.note).toBeUndefined();
    });

    it("refuses binary files with the shared named dead end", async () => {
      const { executors } = await setup({ "src/blob.bin": "abc\0def\n" });

      const out = (await executors.readWorkspaceFile({ path: "src/blob.bin" })) as {
        refused?: boolean;
        reason?: string;
      };

      expect(out.refused).toBe(true);
      expect(out.reason).toBe("Binary file cannot be read as text.");
    });

    it("caps oversized reads at the shared response budget with a resume offset", async () => {
      const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
      const { executors } = await setup({ "src/big.txt": bigFile });

      const out = (await executors.readWorkspaceFile({ path: "src/big.txt" })) as {
        truncated?: boolean;
        truncationReason?: string;
        resumeStartLine?: number;
        endLine?: number;
        returnedBytes?: number;
      };

      expect(out.truncated).toBe(true);
      expect(out.truncationReason).toBe("response byte budget exceeded");
      expect(out.returnedBytes).toBeLessThanOrEqual(LOCAL_WORKSPACE_READ_RESPONSE_BYTES);
      expect(out.endLine).toBeGreaterThan(1);
      expect(out.resumeStartLine).toBe(out.endLine);
    });

    it("supports line-window reads like every other feature", async () => {
      const { executors } = await setup({ "src/app.ts": "a\nb\nc\nd\n" });

      const out = (await executors.readWorkspaceFile({
        path: "src/app.ts",
        startLine: 2,
        maxLines: 2,
      })) as {
        content?: string;
        startLine?: number;
        endLine?: number;
        truncated?: boolean;
        resumeStartLine?: number;
        note?: string;
      };

      expect(out.content).toBe("b\nc");
      expect(out.startLine).toBe(2);
      expect(out.endLine).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.resumeStartLine).toBe(4);
      expect(out.note).toBe("Line window ended at line 3 of 4. Resume with startLine 4.");
    });

    it("strips BOM and normalizes CRLF so line numbers match diff and blame", async () => {
      const { executors } = await setup({ "src/crlf.ts": "\uFEFFone\r\ntwo\r\n" });

      const out = (await executors.readWorkspaceFile({ path: "src/crlf.ts" })) as {
        content?: string;
        endLine?: number;
      };

      expect(out.content).toBe("one\ntwo\n");
      expect(out.endLine).toBe(2);
    });
  });

  describe("searchWorkspace and getWorkspaceDiff", () => {
    it("records a Git version that supports workspace grep --max-count", async () => {
      const { stdout } = await exec("git", ["--version"]);
      // Shared grepLiteral uses --max-count (Git 2.40+). This environment: git 2.43.0.
      expect(stdout.trim()).toMatch(/^git version (?:2\.(?:4[0-9]|[5-9]\d|\d{3,})|[3-9]|[1-9]\d)/);
    });

    it("reads, searches, and returns the cached PR patch from a production workspace", async () => {
      const { workspace, executors } = await setup(
        { "src/app.ts": "export const needle = 1;\n" },
        { patches: { "src/app.ts": APP_PATCH } },
      );

      await expect(stat(join(workspace.agentCwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(workspace.privateGitDir)).isDirectory()).toBe(true);
      expect(workspace.privateGitDir.startsWith(`${workspace.agentCwd}/`)).toBe(false);

      const read = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
        content?: string;
      };
      expect(read.content).toBe("export const needle = 1;\n");

      const search = await executors.searchWorkspace({ query: "needle" });
      expect(search).toEqual({
        matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
        truncated: false,
      });

      const diff = await executors.getWorkspaceDiff({ path: "src/app.ts" });
      expect(diff).toEqual({ path: "src/app.ts", diff: APP_PATCH });
    });

    it("returns empty matches when searchWorkspace finds nothing", async () => {
      const { executors } = await setup({ "src/app.ts": "const value = 1;\n" });
      const out = await executors.searchWorkspace({ query: "no-such-token-xyz" });
      expect(out).toEqual({ matches: [], truncated: false });
    });

    it("returns clean-path hits without a filtered marker", async () => {
      const { executors } = await setup({
        "src/safe-a.ts": "export const safeA = needle;\n",
        "src/safe-b.ts": "export const safeB = needle;\n",
      });

      const out = await executors.searchWorkspace({ query: "needle" });
      expect(out).toEqual({
        matches: [
          { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
          { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
        ],
        truncated: false,
      });
    });

    it("filters blocked paths before applying the result cap", async () => {
      const blockedText = "verify-private-value-540";
      const { executors } = await setup({
        ".env": `TOKEN=${blockedText} needle\n`,
        ".npmrc": `//registry.example/:_authToken=${blockedText} needle\n`,
        ".aws/credentials": `[default]\naws_secret_access_key=${blockedText} needle\n`,
        "certs/signing.pem": `-----BEGIN PRIVATE KEY----- ${blockedText} needle\n`,
        ".github/workflows/ci.yml": `name: ${blockedText} needle\n`,
        "src/safe-a.ts": "export const safeA = needle;\n",
        "src/safe-b.ts": "export const safeB = needle;\n",
        "src/safe-c.ts": "export const safeC = needle;\n",
      });

      const out = (await executors.searchWorkspace({ query: "needle", maxResults: 2 })) as {
        matches: Array<{ path: string; line: number; text: string }>;
        truncated: boolean;
        filtered?: boolean;
      };

      expect(out).toEqual({
        matches: [
          { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
          { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
        ],
        truncated: true,
        filtered: true,
      });
      expect(JSON.stringify(out)).not.toContain(blockedText);
      expect(JSON.stringify(out)).not.toContain(".env");
      expect(JSON.stringify(out)).not.toContain(".npmrc");
    });

    it("strips source symlinks and withholds blocked checkout paths", async () => {
      const root = await mkdtemp(join(tmpdir(), "verification-ws-symlink-"));
      sources.push(root);
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      await exec("git", ["init", repo]);
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Test"], { cwd: repo });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
      await writeTree(repo, {
        ".env": "TOKEN=verify-private-value-540\n",
        "src/safe.ts": "export const safe = true;\n",
      });
      await mkdir(join(repo, "docs"), { recursive: true });
      await symlink("../.env", join(repo, "docs", "config.ts"));
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "head"], { cwd: repo });
      const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await exec("git", ["init", "--bare", remote]);
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "origin", "HEAD:refs/pull/1/head"], { cwd: repo });

      const workspace = await prepareLocalPrWorkspace({
        owner: "owner",
        repo: "repo",
        prNumber: 1,
        headSha,
        installationToken: "unused",
        prFiles: {
          files: [],
          truncated: false,
          omittedCountLowerBound: 0,
          totalChanges: 0,
          headSha,
        },
        remoteUrlOverride: remote,
      });
      workspaces.push(workspace);
      const { executors } = buildVerificationWorkspaceTools({
        cfg: makeTestConfig(),
        workspace,
      });

      await expect(stat(join(workspace.agentCwd, "docs", "config.ts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(isTriageSearchPathAllowed(workspace.agentCwd, "././.env")).resolves.toBe(false);
      await expect(isTriageSearchPathAllowed(workspace.agentCwd, "src/safe.ts")).resolves.toBe(
        true,
      );
      await expect(executors.searchWorkspace({ query: "TOKEN" })).resolves.toEqual({
        matches: [],
        truncated: false,
        filtered: true,
      });
      await expect(executors.searchWorkspace({ query: "safe" })).resolves.toEqual({
        matches: [{ path: "src/safe.ts", line: 1, text: "export const safe = true;" }],
        truncated: false,
        filtered: true,
      });
    });

    it("withholds key-extension and control-path hits", async () => {
      const blockedText = "verify-private-value-540";
      const { executors } = await setup({
        "certs/server.key": `secret=${blockedText}\n`,
        "package.json": `{"name":"${blockedText}"}\n`,
        "src/key-utils.ts": "export const helper = true;\n",
      });

      const secretOut = (await executors.searchWorkspace({ query: blockedText })) as {
        matches: unknown[];
        truncated?: boolean;
        filtered?: boolean;
      };
      expect(secretOut.matches).toEqual([]);
      expect(secretOut.truncated).toBe(false);
      expect(secretOut.filtered).toBe(true);
      expect(JSON.stringify(secretOut)).not.toContain(blockedText);

      const cleanOut = await executors.searchWorkspace({ query: "helper" });
      expect(cleanOut).toEqual({
        matches: [{ path: "src/key-utils.ts", line: 1, text: "export const helper = true;" }],
        truncated: false,
        filtered: true,
      });
    });

    it("matches literal punctuation and unusual filenames", async () => {
      const { executors } = await setup({
        "src/colon:name.ts": "export const token = 'a.b*c';\n",
      });

      const out = await executors.searchWorkspace({ query: "a.b*c" });
      expect(out).toEqual({
        matches: [{ path: "src/colon:name.ts", line: 1, text: "export const token = 'a.b*c';" }],
        truncated: false,
      });
    });

    it("returns a deleted path's cached PR patch without requiring the file at head", async () => {
      const { workspace, executors } = await setup(
        { "src/app.ts": "export {};\n" },
        {
          deletedFiles: { "src/gone.ts": "export const removed = true;\n" },
          patches: { "src/gone.ts": GONE_PATCH },
        },
      );

      await expect(stat(join(workspace.agentCwd, "src", "gone.ts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(executors.getWorkspaceDiff({ path: "src/gone.ts" })).resolves.toEqual({
        path: "src/gone.ts",
        diff: GONE_PATCH,
      });
    });

    it("returns an omitted-patch notice and an empty string for an absent patch", async () => {
      const { executors } = await setup(
        {
          "src/omitted.ts": "export const omitted = true;\n",
          "src/absent.ts": "export const absent = true;\n",
        },
        {
          omittedPatchPaths: ["src/omitted.ts"],
          absentPatchPaths: ["src/absent.ts"],
        },
      );

      await expect(executors.getWorkspaceDiff({ path: "src/omitted.ts" })).resolves.toEqual({
        path: "src/omitted.ts",
        diff: "[patch omitted: exceeds configured PR patch byte cap]",
      });
      await expect(executors.getWorkspaceDiff({ path: "src/absent.ts" })).resolves.toEqual({
        path: "src/absent.ts",
        diff: "",
      });
    });

    it("forwards workspace search truncation and the shared byte cap", async () => {
      const root = await mkdtemp(join(tmpdir(), "verification-ws-budget-"));
      sources.push(root);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "export const needle = 1;\n");
      let seenBytes: number | undefined;
      const workspace = {
        ...mockLocalPrWorkspace(root, { checkoutPaths: new Set(["src/app.ts"]) }),
        grepLiteral: async (params: { readonly maxOutputBytes?: number }) => {
          seenBytes = params.maxOutputBytes;
          return {
            matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
            truncated: true,
          };
        },
      };
      const { executors } = buildVerificationWorkspaceTools({
        cfg: makeTestConfig(),
        workspace,
      });

      const out = await executors.searchWorkspace({ query: "needle" });
      expect(seenBytes).toBe(LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES);
      expect(out).toEqual({
        matches: [{ path: "src/app.ts", line: 1, text: "export const needle = 1;" }],
        truncated: true,
      });
    });
  });
});
