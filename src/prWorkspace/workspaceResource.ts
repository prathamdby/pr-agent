import { mkdtemp, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors/appError.ts";
import { LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS } from "../settings/index.ts";
import { isPlainObject } from "../util/typeGuards.ts";
import {
  createGitCredentialFiles,
  GIT_ASKPASS_NAME,
  GIT_TOKEN_FILE_NAME,
  makeDirectoriesWritable,
  type GitCredentialFiles,
} from "./gitCredentials.ts";

export function assertGitSha(value: string, field: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "invalid_sha",
      message: `${field} must be a 40-character SHA`,
      context: { field },
    });
  }
}

export function assertGitRepoPart(value: string, field: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "unsafe_repo_part",
      message: `${field} is not git-safe`,
      context: { field },
    });
  }
}

export async function ensureWorkspaceFreeSpace(dir: string, minBytes: number, message: string) {
  const fs = await statfs(dir);
  const freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize);
  if (freeBytes < BigInt(minBytes)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "insufficient_free_space",
      message,
      context: { minBytes },
    });
  }
}

export async function ensureWorkspaceFreeSpaceAfterSweep(
  dir: string,
  minBytes: number,
  message: string,
  sweep: () => Promise<void>,
) {
  try {
    await ensureWorkspaceFreeSpace(dir, minBytes, message);
  } catch (error) {
    if (!(error instanceof AppError && error.code === "pr_workspace.insufficient_free_space")) {
      throw error;
    }
    await sweep();
    await ensureWorkspaceFreeSpace(dir, minBytes, message);
  }
}

export const READONLY_WORKSPACE_ROOT_PREFIX = "pr-agent-workspace-";
export const WRITABLE_WORKSPACE_ROOT_PREFIX = "pr-agent-triage-";

const WORKSPACE_ROOT_PREFIXES = [
  READONLY_WORKSPACE_ROOT_PREFIX,
  WRITABLE_WORKSPACE_ROOT_PREFIX,
] as const;

type WorkspaceRootPrefix = (typeof WORKSPACE_ROOT_PREFIXES)[number];

const WORKSPACE_OWNER_MARKER_NAME = ".pr-agent-workspace-owner.json";

type WorkspaceOwnerMarker = {
  readonly pid: number;
  readonly heartbeatAtMs: number;
};

export type WorkspaceResource = {
  readonly rootDir: string;
  readonly credentials: GitCredentialFiles;
  readonly release: () => Promise<void>;
};

type AllocateWorkspaceResourceParams = {
  readonly prefix: WorkspaceRootPrefix;
  readonly installationToken: string;
  readonly createCredentials?: (rootDir: string, token: string) => Promise<GitCredentialFiles>;
  readonly removeRoot?: (rootDir: string) => Promise<void>;
  readonly nowMs?: () => number;
  readonly heartbeatIntervalMs?: number;
};

type SweepStaleOwnedWorkspacesOptions = {
  readonly nowMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly staleAgeSeconds?: number;
};

const liveWorkspaceRoots = new Set<string>();

function ownerHeartbeatIntervalMs(staleAgeSeconds: number) {
  const staleMs = staleAgeSeconds * 1000;
  return ((pinnedReturn: number) => pinnedReturn)(
    Math.min(30_000, Math.max(1_000, Math.floor(staleMs / 12))),
  );
}

function isWorkspaceOwnerPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  try {
    process.kill(pid, 0);
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  } catch {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
}

function isWorkspaceRootPrefix(value: string): value is WorkspaceRootPrefix {
  return WORKSPACE_ROOT_PREFIXES.some((prefix) => prefix === value);
}

function ownerMarkerPath(rootDir: string) {
  return ((pinnedReturn: string) => pinnedReturn)(join(rootDir, WORKSPACE_OWNER_MARKER_NAME));
}

async function writeWorkspaceOwnerMarker(rootDir: string, marker: WorkspaceOwnerMarker) {
  const target = ownerMarkerPath(rootDir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

async function readWorkspaceOwnerMarker(rootDir: string) {
  const raw = await readFile(ownerMarkerPath(rootDir), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw == null)
    return ((pinnedReturn: (WorkspaceOwnerMarker | null) | Promise<WorkspaceOwnerMarker | null>) =>
      pinnedReturn)(null);
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value))
      return ((
        pinnedReturn: (WorkspaceOwnerMarker | null) | Promise<WorkspaceOwnerMarker | null>,
      ) => pinnedReturn)(null);
    const pid = value.pid;
    const heartbeatAtMs = value.heartbeatAtMs;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof heartbeatAtMs !== "number" ||
      !Number.isFinite(heartbeatAtMs)
    ) {
      return ((
        pinnedReturn: (WorkspaceOwnerMarker | null) | Promise<WorkspaceOwnerMarker | null>,
      ) => pinnedReturn)(null);
    }
    return ((pinnedReturn: (WorkspaceOwnerMarker | null) | Promise<WorkspaceOwnerMarker | null>) =>
      pinnedReturn)({ pid, heartbeatAtMs });
  } catch {
    return ((pinnedReturn: (WorkspaceOwnerMarker | null) | Promise<WorkspaceOwnerMarker | null>) =>
      pinnedReturn)(null);
  }
}

function isLiveWorkspaceOwnerMarker(
  marker: WorkspaceOwnerMarker | null,
  nowMs: number,
  staleAgeMs: number,
  isPidAlive: (pid: number) => boolean,
) {
  if (marker == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (nowMs - marker.heartbeatAtMs <= staleAgeMs)
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(isPidAlive(marker.pid));
}

async function removeWorkspaceRoot(rootDir: string) {
  await makeDirectoriesWritable(rootDir);
  await rm(rootDir, { recursive: true, force: true });
}

async function removeCredentialFiles(rootDir: string) {
  await rm(join(rootDir, GIT_ASKPASS_NAME), { force: true }).catch(() => undefined);
  await rm(join(rootDir, GIT_TOKEN_FILE_NAME), { force: true }).catch(() => undefined);
}

export async function statIfPresent(path: string) {
  return stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

export async function allocateWorkspaceResource(params: AllocateWorkspaceResourceParams) {
  if (!isWorkspaceRootPrefix(params.prefix)) {
    throw new AppError({
      domain: "pr_workspace",
      kind: "unsafe_root_prefix",
      message: "Workspace temp-root prefix is not a known owned prefix",
      context: { prefix: params.prefix },
    });
  }

  const nowMs = params.nowMs ?? Date.now;
  const createCredentials = params.createCredentials ?? createGitCredentialFiles;
  const removeRoot = params.removeRoot ?? removeWorkspaceRoot;
  const heartbeatIntervalMs =
    params.heartbeatIntervalMs ??
    ownerHeartbeatIntervalMs(LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS);

  const rootDir = await mkdtemp(join(tmpdir(), params.prefix));
  let released = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let credentials: GitCredentialFiles | undefined;

  const stopHeartbeat = () => {
    if (heartbeat == null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const release = async () => {
    if (released) return;
    released = true;
    stopHeartbeat();
    liveWorkspaceRoots.delete(rootDir);
    await rm(ownerMarkerPath(rootDir), { force: true }).catch(() => undefined);
    if (credentials) {
      await credentials.cleanup().catch(() => undefined);
    } else {
      await removeCredentialFiles(rootDir);
    }
    await removeRoot(rootDir).catch(() => undefined);
  };

  const writeHeartbeat = async () => {
    if (released) return;
    await writeWorkspaceOwnerMarker(rootDir, {
      pid: process.pid,
      heartbeatAtMs: nowMs(),
    });
    if (released) {
      await rm(ownerMarkerPath(rootDir), { force: true }).catch(() => undefined);
    }
  };

  try {
    await writeHeartbeat();
    liveWorkspaceRoots.add(rootDir);
    heartbeat = setInterval(() => {
      void writeHeartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref();
    credentials = await createCredentials(rootDir, params.installationToken);
    return ((pinnedReturn: WorkspaceResource | Promise<WorkspaceResource>) => pinnedReturn)({
      rootDir,
      credentials,
      release,
    });
  } catch (error) {
    await release();
    throw error;
  }
}

export async function sweepStaleOwnedWorkspaces(options: SweepStaleOwnedWorkspacesOptions = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const isPidAlive = options.isPidAlive ?? isWorkspaceOwnerPidAlive;
  const staleAgeMs = (options.staleAgeSeconds ?? LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS) * 1000;
  const tmp = tmpdir();

  for (const entry of await readdir(tmp, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !WORKSPACE_ROOT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
    ) {
      continue;
    }
    const full = join(tmp, entry.name);
    if (liveWorkspaceRoots.has(full)) continue;

    const entryStat = await statIfPresent(full);
    if (!entryStat) continue;

    const marker = await readWorkspaceOwnerMarker(full).catch(() => null);
    if (isLiveWorkspaceOwnerMarker(marker, nowMs, staleAgeMs, isPidAlive)) continue;

    const ageMs = nowMs - entryStat.mtimeMs;
    if (ageMs <= staleAgeMs) continue;

    const latest = await readWorkspaceOwnerMarker(full).catch(() => null);
    if (liveWorkspaceRoots.has(full)) continue;
    if (isLiveWorkspaceOwnerMarker(latest, nowMs, staleAgeMs, isPidAlive)) continue;
    await removeWorkspaceRoot(full).catch(() => undefined);
  }
}
