import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors/appError.js";
import { LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS } from "../settings/index.js";
import { isPlainObject } from "../util/typeGuards.js";
import {
  createGitCredentialFiles,
  GIT_ASKPASS_NAME,
  GIT_TOKEN_FILE_NAME,
  makeDirectoriesWritable,
  type GitCredentialFiles,
} from "./gitCredentials.js";

/** Read-only investigation checkout temp-root prefix. */
export const READONLY_WORKSPACE_ROOT_PREFIX = "pr-agent-workspace-";
/** Writable triage checkout temp-root prefix. */
export const WRITABLE_WORKSPACE_ROOT_PREFIX = "pr-agent-triage-";

export const WORKSPACE_ROOT_PREFIXES = [
  READONLY_WORKSPACE_ROOT_PREFIX,
  WRITABLE_WORKSPACE_ROOT_PREFIX,
] as const;

export type WorkspaceRootPrefix = (typeof WORKSPACE_ROOT_PREFIXES)[number];

/** On-disk ownership marker. Heartbeat, not the in-process live set, is sweep safety. */
export const WORKSPACE_OWNER_MARKER_NAME = ".pr-agent-workspace-owner.json";

export type WorkspaceOwnerMarker = {
  readonly pid: number;
  readonly heartbeatAtMs: number;
};

export type WorkspaceResource = {
  readonly rootDir: string;
  readonly credentials: GitCredentialFiles;
  readonly release: () => Promise<void>;
};

export type AllocateWorkspaceResourceParams = {
  readonly prefix: WorkspaceRootPrefix;
  readonly installationToken: string;
  readonly createCredentials?: (rootDir: string, token: string) => Promise<GitCredentialFiles>;
  readonly nowMs?: () => number;
  readonly heartbeatIntervalMs?: number;
};

export type SweepStaleOwnedWorkspacesOptions = {
  readonly nowMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
};

/** In-process optimization only. Sweeps must still honor the on-disk marker. */
const liveWorkspaceRoots = new Set<string>();

export function registerLiveLocalPrWorkspace(rootDir: string): void {
  liveWorkspaceRoots.add(rootDir);
}

export function unregisterLiveLocalPrWorkspace(rootDir: string): void {
  liveWorkspaceRoots.delete(rootDir);
}

export function isRegisteredLiveLocalPrWorkspace(rootDir: string): boolean {
  return liveWorkspaceRoots.has(rootDir);
}

export function ownerHeartbeatIntervalMs(staleAgeSeconds: number): number {
  const staleMs = staleAgeSeconds * 1000;
  return Math.min(30_000, Math.max(1_000, Math.floor(staleMs / 12)));
}

export function isWorkspaceOwnerPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWorkspaceRootPrefix(value: string): value is WorkspaceRootPrefix {
  return (WORKSPACE_ROOT_PREFIXES as readonly string[]).includes(value);
}

function ownerMarkerPath(rootDir: string): string {
  return join(rootDir, WORKSPACE_OWNER_MARKER_NAME);
}

export async function writeWorkspaceOwnerMarker(
  rootDir: string,
  marker: WorkspaceOwnerMarker,
): Promise<void> {
  const target = ownerMarkerPath(rootDir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export async function readWorkspaceOwnerMarker(
  rootDir: string,
): Promise<WorkspaceOwnerMarker | null> {
  const raw = await readFile(ownerMarkerPath(rootDir), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value)) return null;
    const pid = value.pid;
    const heartbeatAtMs = value.heartbeatAtMs;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof heartbeatAtMs !== "number" ||
      !Number.isFinite(heartbeatAtMs)
    ) {
      return null;
    }
    return { pid, heartbeatAtMs };
  } catch {
    return null;
  }
}

export function isLiveWorkspaceOwnerMarker(
  marker: WorkspaceOwnerMarker | null,
  nowMs: number,
  staleAgeMs: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (marker == null) return false;
  if (nowMs - marker.heartbeatAtMs <= staleAgeMs) return true;
  return isPidAlive(marker.pid);
}

export async function removeWorkspaceRoot(rootDir: string): Promise<void> {
  await makeDirectoriesWritable(rootDir);
  await rm(rootDir, { recursive: true, force: true });
}

async function removeCredentialFiles(rootDir: string): Promise<void> {
  await rm(join(rootDir, GIT_ASKPASS_NAME), { force: true }).catch(() => undefined);
  await rm(join(rootDir, GIT_TOKEN_FILE_NAME), { force: true }).catch(() => undefined);
}

async function statIfPresent(path: string) {
  return stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Allocate a temp root, persist an ownership marker, then create credentials.
 * Every failure after mkdtemp uses the same idempotent release path.
 */
export async function allocateWorkspaceResource(
  params: AllocateWorkspaceResourceParams,
): Promise<WorkspaceResource> {
  if (!isWorkspaceRootPrefix(params.prefix)) {
    throw new AppError({
      code: "pr_workspace.unsafe_root_prefix",
      message: "Workspace temp-root prefix is not a known owned prefix",
      context: { prefix: params.prefix },
    });
  }

  const nowMs = params.nowMs ?? Date.now;
  const createCredentials = params.createCredentials ?? createGitCredentialFiles;
  const heartbeatIntervalMs =
    params.heartbeatIntervalMs ??
    ownerHeartbeatIntervalMs(LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS);

  const rootDir = await mkdtemp(join(tmpdir(), params.prefix));
  let released = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let credentials: GitCredentialFiles | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeat == null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopHeartbeat();
    unregisterLiveLocalPrWorkspace(rootDir);
    if (credentials) {
      await credentials.cleanup().catch(() => undefined);
    } else {
      await removeCredentialFiles(rootDir);
    }
    await removeWorkspaceRoot(rootDir).catch(() => undefined);
  };

  const writeHeartbeat = async (): Promise<void> => {
    if (released) return;
    await writeWorkspaceOwnerMarker(rootDir, {
      pid: process.pid,
      heartbeatAtMs: nowMs(),
    });
  };

  try {
    await writeHeartbeat();
    registerLiveLocalPrWorkspace(rootDir);
    heartbeat = setInterval(() => {
      void writeHeartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref();
    credentials = await createCredentials(rootDir, params.installationToken);
    return {
      rootDir,
      credentials,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function sweepStaleOwnedWorkspaces(
  options: SweepStaleOwnedWorkspacesOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const isPidAlive = options.isPidAlive ?? isWorkspaceOwnerPidAlive;
  const staleAgeMs = LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS * 1000;
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

    // Re-read immediately before delete so a heartbeat that landed during the walk wins.
    const latest = await readWorkspaceOwnerMarker(full).catch(() => null);
    if (liveWorkspaceRoots.has(full)) continue;
    if (isLiveWorkspaceOwnerMarker(latest, nowMs, staleAgeMs, isPidAlive)) continue;
    await removeWorkspaceRoot(full).catch(() => undefined);
  }
}
