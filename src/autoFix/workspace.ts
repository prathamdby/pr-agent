import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import type { ListPullRequestFilesResult } from "../github/listPullRequestFiles.js";
import { assertWorkspacePath } from "../prWorkspace/localPrWorkspace.js";
import type { BotIdentity } from "../github/appAuth.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT_PREFIX = "pr-agent-fix-";
const PRIVATE_GIT_DIR = "private";
const WORKTREE_DIR = "worktree";
const SCRATCH_DIR = "scratch";
const ASKPASS_NAME = "git-askpass.sh";
const TOKEN_FILE_NAME = "git-token";
const PR_HEAD_REF = "pr-head";
const BINARY_SAMPLE_BYTES = 8192;

type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "other";

type AutoFixChangedFile = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly oldPath?: string;
};

export type AutoFixCommit = {
  readonly sha: string;
  readonly message: string;
  readonly changedPaths: readonly string[];
};

export type AutoFixWorkspace = {
  readonly rootDir: string;
  readonly privateGitDir: string;
  readonly worktreeDir: string;
  readonly scratchCwd: string;
  readonly changedFiles: readonly AutoFixChangedFile[];
  readonly listFiles: () => Promise<string[]>;
  readonly readTextFile: (path: string) => Promise<{ size: number; content: string }>;
  readonly search: (
    query: string,
    maxResults: number,
  ) => Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
  }>;
  readonly getPrDiff: (path?: string) => Promise<string>;
  readonly getWorktreeDiff: () => Promise<string>;
  readonly editTextFile: (path: string, oldText: string, newText: string) => Promise<void>;
  readonly writeTextFile: (path: string, content: string) => Promise<void>;
  readonly deletePath: (path: string) => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly commitAll: (message: string) => Promise<AutoFixCommit | null>;
  readonly pushHeadToBranch: (
    remoteUrl: string,
    branch: string,
    opts?: { readonly forceWithLeaseSha?: string | null },
  ) => Promise<void>;
  readonly cleanup: () => Promise<void>;
};

export type PrepareAutoFixWorkspaceParams = {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationToken: string;
  readonly prFiles: ListPullRequestFilesResult;
  readonly bot: BotIdentity;
  readonly remoteUrlOverride?: string;
};

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a 40-character SHA`);
}

function assertRepoPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${field} is not git-safe`);
}

function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function mapGithubStatus(file: ListPullRequestFilesResult["files"][number]): AutoFixChangedFile {
  const status = file.status;
  if (status === "renamed" && file.previousFilename) {
    return { path: file.filename, status: "renamed", oldPath: file.previousFilename };
  }
  if (status === "copied" && file.previousFilename) {
    return { path: file.filename, status: "copied", oldPath: file.previousFilename };
  }
  const mapped: ChangedFileStatus =
    status === "added"
      ? "added"
      : status === "removed"
        ? "deleted"
        : status === "modified" || status === "changed"
          ? "modified"
          : "other";
  return { path: file.filename, status: mapped };
}

async function ensureFreeSpace(dir: string, minBytes: number): Promise<void> {
  const fs = await statfs(dir);
  const freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize);
  if (freeBytes < BigInt(minBytes)) {
    throw new Error("Insufficient free space for auto-fix workspace");
  }
}

async function createAskpass(rootDir: string): Promise<string> {
  const askpass = join(rootDir, ASKPASS_NAME);
  await writeFile(
    askpass,
    [
      "#!/bin/sh",
      'token=""',
      'if [ -n "$GIT_TOKEN_FILE" ] && [ -f "$GIT_TOKEN_FILE" ]; then',
      '  token=$(cat "$GIT_TOKEN_FILE")',
      "fi",
      'case "$1" in',
      "  *Username*) printf '%s\\n' x-access-token ;;",
      "  *) printf '%s\\n' \"$token\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return askpass;
}

async function writeTokenFile(rootDir: string, token: string): Promise<string> {
  const tokenFile = join(rootDir, TOKEN_FILE_NAME);
  await writeFile(tokenFile, token, { mode: 0o600 });
  return tokenFile;
}

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isDirectory()) {
      await makeWritable(full);
    } else {
      await chmod(full, 0o644).catch(() => undefined);
    }
  }
}

async function removeWorkspace(rootDir: string): Promise<void> {
  await makeWritable(rootDir);
  await rm(rootDir, { recursive: true, force: true });
}

async function execGit(
  args: readonly string[],
  opts: {
    cwd: string;
    workTree: string;
    timeoutMs: number;
    tokenFile: string;
    askpass: string;
  },
): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_DIR: opts.cwd,
    GIT_WORK_TREE: opts.workTree,
    GIT_ASKPASS: opts.askpass,
    GIT_TOKEN_FILE: opts.tokenFile,
  };
  return exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: opts.cwd,
    env,
    timeout: opts.timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function gitSucceeds(
  runGit: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
  args: readonly string[],
): Promise<boolean> {
  try {
    await runGit(args);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkInExistingPath(root: string, normalizedPath: string): Promise<void> {
  const parts = normalizedPath.split("/").filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new Error(`Symlink paths are not allowed: ${normalizedPath}`);
    }
  }
}

async function assertReadableTextFile(
  root: string,
  normalizedPath: string,
  maxBytes: number,
): Promise<string> {
  const safePath = assertWorkspacePath(root, normalizedPath);
  await assertNoSymlinkInExistingPath(root, normalizedPath);
  const info = await lstat(safePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Path is not a file: ${normalizedPath}`);
  if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte read limit.`);
  return safePath;
}

async function walkFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        paths.push(rel.replace(/\\/g, "/"));
      }
    }
  }
  await walk(root, "");
  return paths.toSorted();
}

function truncateDiff(diff: string, maxBytes: number): string {
  return diff.length > maxBytes ? `${diff.slice(0, maxBytes)}\n...[diff truncated]` : diff;
}

export async function prepareAutoFixWorkspace(
  params: PrepareAutoFixWorkspaceParams,
): Promise<AutoFixWorkspace> {
  const { cfg, owner, repo, prNumber, headSha, installationToken, prFiles, bot } = params;
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repo");
  assertSha(headSha, "headSha");
  await ensureFreeSpace(tmpdir(), cfg.localWorkspaceMinFreeSpaceBytes);

  const rootDir = await mkdtemp(join(tmpdir(), WORKSPACE_ROOT_PREFIX));
  const privateGitDir = join(rootDir, PRIVATE_GIT_DIR);
  const worktreeDir = join(rootDir, WORKTREE_DIR);
  const scratchCwd = join(rootDir, SCRATCH_DIR);
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const askpass = await createAskpass(rootDir);
  const tokenFile = await writeTokenFile(rootDir, installationToken);
  const patchByPath = new Map<string, string>();
  const changedFiles = prFiles.files.map(mapGithubStatus);

  for (const file of prFiles.files) {
    if (file.patch) patchByPath.set(file.filename, file.patch);
  }

  const git = (args: readonly string[], timeoutMs = cfg.localWorkspaceFetchTimeoutMs) =>
    execGit(args, {
      cwd: privateGitDir,
      workTree: worktreeDir,
      timeoutMs,
      tokenFile,
      askpass,
    });

  try {
    await mkdir(privateGitDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(scratchCwd, { recursive: true });
    await git(["init"], cfg.localWorkspaceCloneTimeoutMs);
    await git(["remote", "add", "origin", remoteUrl], cfg.localWorkspaceCloneTimeoutMs);
    const prRef = `+refs/pull/${prNumber}/head:refs/heads/${PR_HEAD_REF}`;
    await git(
      ["fetch", "--no-tags", "--depth=1", "--no-recurse-submodules", "origin", prRef],
      cfg.localWorkspaceFetchTimeoutMs,
    );
    await git(["checkout", "-f", PR_HEAD_REF], cfg.localWorkspaceCloneTimeoutMs);
    const { stdout: fetchedHead } = await git(["rev-parse", "HEAD"]);
    if (fetchedHead.trim().toLowerCase() !== headSha.toLowerCase()) {
      throw new Error(
        `Fetched PR head ${fetchedHead.trim()} does not match expected headSha ${headSha}`,
      );
    }
    const email = `${bot.userId}+${bot.login}@users.noreply.github.com`;
    await git(["config", "user.name", bot.login], cfg.localWorkspaceCloneTimeoutMs);
    await git(["config", "user.email", email], cfg.localWorkspaceCloneTimeoutMs);

    async function readTextFile(path: string): Promise<{ size: number; content: string }> {
      const normalized = normalizePath(path);
      const safePath = await assertReadableTextFile(
        worktreeDir,
        normalized,
        cfg.localWorkspaceMaxFileBytes,
      );
      const buf = await readFile(safePath);
      if (looksBinary(buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)))) {
        throw new Error(`Binary file cannot be read as text: ${normalized}`);
      }
      return { size: buf.length, content: buf.toString("utf8") };
    }

    async function writeTextFile(path: string, content: string): Promise<void> {
      const normalized = normalizePath(path);
      const safePath = assertWorkspacePath(worktreeDir, normalized);
      await assertNoSymlinkInExistingPath(worktreeDir, normalized);
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, content, "utf8");
    }

    async function getWorktreeDiff(): Promise<string> {
      const { stdout } = await git(["diff", "--", "."], cfg.localWorkspaceFetchTimeoutMs);
      return truncateDiff(stdout, cfg.localWorkspaceMaxDiffBytes);
    }

    async function changedPathsFromWorktree(): Promise<string[]> {
      const { stdout } = await git(["diff", "--name-only", "--", "."]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .toSorted();
    }

    return {
      rootDir,
      privateGitDir,
      worktreeDir,
      scratchCwd,
      changedFiles,
      listFiles: () => walkFiles(worktreeDir),
      readTextFile,
      search: async (query, maxResults) => {
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const path of await walkFiles(worktreeDir)) {
          if (matches.length >= maxResults) return { matches, truncated: true };
          const safePath = await assertReadableTextFile(
            worktreeDir,
            path,
            cfg.localWorkspaceMaxFileBytes,
          ).catch(() => null);
          if (!safePath) continue;
          const buf = await readFile(safePath).catch(() => Buffer.alloc(0));
          if (looksBinary(buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)))) continue;
          const lines = buf.toString("utf8").split("\n");
          for (const [index, line] of lines.entries()) {
            if (!line.includes(query)) continue;
            matches.push({ path, line: index + 1, text: line });
            if (matches.length >= maxResults) return { matches, truncated: true };
          }
        }
        return { matches, truncated: false };
      },
      getPrDiff: async (path) => {
        if (path) {
          const normalized = normalizePath(path);
          return truncateDiff(patchByPath.get(normalized) ?? "", cfg.localWorkspaceMaxDiffBytes);
        }
        return truncateDiff([...patchByPath.values()].join("\n"), cfg.localWorkspaceMaxDiffBytes);
      },
      getWorktreeDiff,
      editTextFile: async (path, oldText, newText) => {
        const current = await readTextFile(path);
        if (!current.content.includes(oldText)) {
          throw new Error(`oldText not found in ${normalizePath(path)}`);
        }
        await writeTextFile(path, current.content.replace(oldText, newText));
      },
      writeTextFile,
      deletePath: async (path) => {
        const normalized = normalizePath(path);
        const safePath = assertWorkspacePath(worktreeDir, normalized);
        await assertNoSymlinkInExistingPath(worktreeDir, normalized);
        await rm(safePath, { recursive: true, force: true });
      },
      reset: async () => {
        await git(["reset", "--hard", "HEAD"], cfg.localWorkspaceCloneTimeoutMs);
        await git(["clean", "-fd"], cfg.localWorkspaceCloneTimeoutMs);
      },
      commitAll: async (message) => {
        const changedPaths = await changedPathsFromWorktree();
        if (changedPaths.length === 0) return null;
        await git(["diff", "--check"], cfg.localWorkspaceFetchTimeoutMs);
        await git(["add", "-A"], cfg.localWorkspaceCloneTimeoutMs);
        const hasStagedChanges = !(await gitSucceeds(git, ["diff", "--cached", "--quiet"]));
        if (!hasStagedChanges) return null;
        await git(["commit", "-m", message], cfg.localWorkspaceCloneTimeoutMs);
        const { stdout } = await git(["rev-parse", "HEAD"]);
        return { sha: stdout.trim(), message, changedPaths };
      },
      pushHeadToBranch: async (pushRemoteUrl, branch, opts) => {
        const refspec = `HEAD:refs/heads/${branch}`;
        const lease = opts?.forceWithLeaseSha
          ? [`--force-with-lease=refs/heads/${branch}:${opts.forceWithLeaseSha}`]
          : [];
        await git(["push", pushRemoteUrl, ...lease, refspec], cfg.localWorkspaceFetchTimeoutMs);
      },
      cleanup: () => removeWorkspace(rootDir),
    };
  } catch (error) {
    await removeWorkspace(rootDir).catch(() => undefined);
    throw error;
  }
}
