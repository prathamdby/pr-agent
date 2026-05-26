import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../agent/reviewDiffIndex.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT_PREFIX = "pr-agent-workspace-";
const PRIVATE_CHECKOUT_DIR = "private";
const AGENT_TREE_DIR = "agent";
const ASKPASS_NAME = "git-askpass.sh";

type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "other";

export type LocalPrChangedFile = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly oldPath?: string;
};

export type LocalPrWorkspace = {
  readonly rootDir: string;
  readonly privateGitDir: string;
  readonly agentCwd: string;
  readonly changedFiles: readonly LocalPrChangedFile[];
  readonly materializedPaths: ReadonlySet<string>;
  readonly diffIndex: CachedPrDiffIndex;
  readonly stats: {
    readonly truncated: boolean;
    readonly totalChanges: number;
    readonly fileCount: number;
  };
  readonly getDiffForPath: (path: string) => Promise<string>;
  readonly getBlameForPath: (path: string) => Promise<string>;
  readonly materializePath: (path: string) => Promise<"materialized" | "already" | "refused">;
  readonly cleanup: () => Promise<void>;
};

export type PrepareLocalPrWorkspaceParams = {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly installationToken: string;
  readonly remoteUrlOverride?: string;
};

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a 40-character SHA`);
}

function assertRepoPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${field} is not git-safe`);
}

export function assertWorkspacePath(root: string, requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Path traversal attempt detected: ${requestedPath}`);
  }
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error(`Path traversal attempt detected: ${requestedPath}`);
  }
  return resolved;
}

async function execGit(
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; token?: string; askpass?: string },
): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...(opts.askpass ? { GIT_ASKPASS: opts.askpass, GIT_ASKPASS_TOKEN: opts.token ?? "" } : {}),
  };
  return exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: opts.cwd,
    env,
    timeout: opts.timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function ensureFreeSpace(dir: string, minBytes: number): Promise<void> {
  const fs = await statfs(dir);
  const freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize);
  if (freeBytes < BigInt(minBytes)) {
    throw new Error("Insufficient free space for local PR workspace");
  }
}

async function createAskpass(rootDir: string): Promise<string> {
  const askpass = join(rootDir, ASKPASS_NAME);
  await writeFile(
    askpass,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\\n' x-access-token ;;",
      "  *Password*) printf '%s\\n' \"$GIT_ASKPASS_TOKEN\" ;;",
      "  *) printf '%s\\n' \"$GIT_ASKPASS_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return askpass;
}

function parseNumstat(output: string): number {
  let total = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw] = line.split("\t");
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (Number.isFinite(added)) total += added;
    if (Number.isFinite(deleted)) total += deleted;
  }
  return total;
}

function isTruncatedPatch(patch: string): boolean {
  return patch.endsWith("\n...[diff truncated]");
}

function parseNameStatus(output: string): LocalPrChangedFile[] {
  const files: LocalPrChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [rawStatus, firstPath, secondPath] = line.split("\t");
    const statusCode = rawStatus?.[0] ?? "";
    if (statusCode === "R") {
      if (firstPath && secondPath)
        files.push({ status: "renamed", oldPath: firstPath, path: secondPath });
      continue;
    }
    if (statusCode === "C") {
      if (firstPath && secondPath)
        files.push({ status: "copied", oldPath: firstPath, path: secondPath });
      continue;
    }
    const path = firstPath;
    if (!path) continue;
    const status: ChangedFileStatus =
      statusCode === "A"
        ? "added"
        : statusCode === "M"
          ? "modified"
          : statusCode === "D"
            ? "deleted"
            : "other";
    files.push({ path, status });
  }
  return files;
}

async function removeSymlinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await rm(full, { force: true });
    } else if (entry.isDirectory()) {
      await removeSymlinks(full);
    }
  }
}

async function setReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await setReadOnly(full);
      await chmod(full, 0o555);
    } else {
      await chmod(full, 0o444);
    }
  }
  await chmod(dir, 0o555);
}

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
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

const PI_AGENT_DIR_PREFIX = "pr-agent-pi-";

export async function cleanupStalePiAgentDirs(cfg: Config): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PI_AGENT_DIR_PREFIX)) continue;
    const full = join(tmpdir(), entry.name);
    const ageMs = now - (await stat(full)).mtimeMs;
    if (ageMs > cfg.localWorkspaceStaleCleanupAgeSeconds * 1000) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function cleanupStaleLocalPrWorkspaces(cfg: Config): Promise<void> {
  await cleanupStalePiAgentDirs(cfg);
  const now = Date.now();
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_ROOT_PREFIX)) continue;
    const full = join(tmpdir(), entry.name);
    const ageMs = now - (await stat(full)).mtimeMs;
    if (ageMs > cfg.localWorkspaceStaleCleanupAgeSeconds * 1000) {
      await removeWorkspace(full).catch(() => undefined);
    }
  }
}

export async function prepareLocalPrWorkspace(
  params: PrepareLocalPrWorkspaceParams,
): Promise<LocalPrWorkspace> {
  const { cfg, owner, repo, prNumber, baseSha, headSha, installationToken } = params;
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repo");
  assertSha(baseSha, "baseSha");
  assertSha(headSha, "headSha");
  await ensureFreeSpace(tmpdir(), cfg.localWorkspaceMinFreeSpaceBytes);

  const rootDir = await mkdtemp(join(tmpdir(), WORKSPACE_ROOT_PREFIX));
  const privateGitDir = join(rootDir, PRIVATE_CHECKOUT_DIR);
  const agentCwd = join(rootDir, AGENT_TREE_DIR);
  const materialized = new Set<string>();
  const remoteUrl = params.remoteUrlOverride ?? `https://github.com/${owner}/${repo}.git`;
  const askpass = await createAskpass(rootDir);
  let changedFiles: LocalPrChangedFile[] = [];
  const diffIndex = createCachedPrDiffIndex();
  let truncated = false;
  let totalChanges = 0;

  const git = (args: readonly string[], timeoutMs = cfg.localWorkspaceFetchTimeoutMs) =>
    execGit(args, { cwd: privateGitDir, timeoutMs, token: installationToken, askpass });

  async function materializePath(path: string): Promise<"materialized" | "already" | "refused"> {
    const normalized = path.replace(/\\/g, "/");
    if (materialized.has(normalized)) return "already";
    if (materialized.size >= cfg.localWorkspaceMaxMaterializedFiles) return "refused";
    const outPath = assertWorkspacePath(agentCwd, normalized);
    const { stdout } = await git(["show", `${headSha}:${normalized}`]);
    const bytes = Buffer.byteLength(stdout);
    if (bytes > cfg.localWorkspaceMaxFileBytes) return "refused";
    let total = 0;
    for (const existing of materialized) {
      total += (await stat(assertWorkspacePath(agentCwd, existing))).size;
    }
    if (total + bytes > cfg.localWorkspaceMaxTotalBytes) return "refused";
    await makeWritable(agentCwd);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, stdout);
    await setReadOnly(agentCwd);
    materialized.add(normalized);
    return "materialized";
  }

  async function getDiffForPath(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, "/");
    const { stdout } = await git([
      "diff",
      "--find-renames",
      "--unified=3",
      `${baseSha}...${headSha}`,
      "--",
      normalized,
    ]);
    return stdout.length > cfg.localWorkspaceMaxDiffBytes
      ? `${stdout.slice(0, cfg.localWorkspaceMaxDiffBytes)}\n...[diff truncated]`
      : stdout;
  }

  async function getBlameForPath(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, "/");
    const changed = changedFiles.find((file) => file.path === normalized);
    if (changed?.status === "deleted") {
      return "";
    }
    const materializedResult = await materializePath(normalized);
    if (materializedResult === "refused") {
      return "";
    }
    const { stdout } = await git(["blame", "--line-porcelain", headSha, "--", normalized]);
    return stdout.length > cfg.localWorkspaceMaxDiffBytes
      ? `${stdout.slice(0, cfg.localWorkspaceMaxDiffBytes)}\n...[blame truncated]`
      : stdout;
  }

  async function fetchPullHeadForMergeBase(): Promise<void> {
    const ref = `+refs/pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`;
    let depth = Math.max(2, cfg.localWorkspaceMaxBlameDeepenCommits);
    const maxDepth = 500;
    for (let attempt = 0; attempt < 8; attempt++) {
      await git(["fetch", "--no-tags", `--depth=${depth}`, "origin", ref]);
      try {
        await git(["cat-file", "-e", `${headSha}^{commit}`]);
        await git(["merge-base", baseSha, headSha]);
        return;
      } catch {
        if (depth >= maxDepth) {
          await git(["fetch", "--no-tags", "origin", headSha]);
          await git(["cat-file", "-e", `${headSha}^{commit}`]);
          await git(["merge-base", baseSha, headSha]);
          return;
        }
        depth = Math.min(depth * 2, maxDepth);
      }
    }
  }

  try {
    await mkdir(privateGitDir, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await git(["init"], cfg.localWorkspaceCloneTimeoutMs);
    await git(["remote", "add", "origin", remoteUrl]);
    await git(["fetch", "--no-tags", "--depth=1", "origin", baseSha]);
    await fetchPullHeadForMergeBase();
    const nameStatus = await git([
      "diff",
      "--name-status",
      "--find-renames",
      `${baseSha}...${headSha}`,
    ]);
    changedFiles = parseNameStatus(nameStatus.stdout);
    const numstat = await git(["diff", "--numstat", `${baseSha}...${headSha}`]);
    totalChanges = parseNumstat(numstat.stdout);
    if (changedFiles.length > cfg.localWorkspaceMaxMaterializedFiles) {
      truncated = true;
    }
    const filesForIndex = [];
    for (const file of changedFiles) {
      if (file.status !== "deleted") {
        const materializedResult = await materializePath(file.path).catch(() => "refused" as const);
        if (materializedResult === "refused") truncated = true;
      }
      const patch = await getDiffForPath(file.path);
      if (isTruncatedPatch(patch)) truncated = true;
      filesForIndex.push({
        filename: file.path,
        patch: isTruncatedPatch(patch) ? undefined : patch,
        patchOmitted: patch.length === 0 || isTruncatedPatch(patch),
      });
    }
    ingestListPullRequestFilesResult(diffIndex, { truncated, files: filesForIndex });
    await rm(askpass, { force: true });
    await removeSymlinks(agentCwd);
    await setReadOnly(agentCwd);
    return {
      rootDir,
      privateGitDir,
      agentCwd,
      changedFiles,
      materializedPaths: materialized,
      diffIndex,
      stats: {
        truncated,
        totalChanges,
        fileCount: changedFiles.length,
      },
      getDiffForPath,
      getBlameForPath,
      materializePath,
      cleanup: () => removeWorkspace(rootDir),
    };
  } catch (e) {
    await removeWorkspace(rootDir).catch(() => undefined);
    throw e;
  }
}
