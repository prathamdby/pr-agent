import { logWarn } from "../evlog.ts";
import {
  AGENT_INSTRUCTION_FILENAMES,
  isAllowlistedPolicyPath,
  LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES,
  LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS,
  MAX_AGENT_INSTRUCTION_FILE_BYTES,
  MAX_REPO_POLICY_FILE_BYTES,
} from "../settings/index.ts";
import { gitCountObjectsStoreBytes } from "./workspaceResource.ts";
import { workspaceGitFailureKind } from "./repositoryReader.ts";

const POLICY_BASE_REF = "refs/pr-agent/policy-base";
const BASE_SHA = /^[0-9a-f]{40,64}$/;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const INSTRUCTION_FILENAMES: ReadonlySet<string> = new Set(AGENT_INSTRUCTION_FILENAMES);

export type PolicySnapshotFile = {
  readonly path: string;
  readonly blobSha: string;
  readonly body: string;
};

export type PolicySnapshotDrop = {
  readonly path: string;
  readonly reason: "non_regular_mode" | "over_cap";
};

export type PolicySnapshotUnavailableReason =
  | "missing_base_sha"
  | "fetch_failed"
  | "object_store_cap"
  | "blob_read_failed";

export type PolicySnapshot =
  | {
      readonly kind: "ok";
      readonly baseSha: string;
      readonly files: readonly PolicySnapshotFile[];
      readonly drops: readonly PolicySnapshotDrop[];
    }
  | { readonly kind: "absent"; readonly baseSha: string }
  | {
      readonly kind: "unavailable";
      readonly reason: PolicySnapshotUnavailableReason;
      readonly baseSha?: string;
    };

type WorkspaceGit = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<{ readonly stdout: string }>;

function unavailable(
  reason: PolicySnapshotUnavailableReason,
  baseSha: string | undefined,
  error?: unknown,
): PolicySnapshot {
  const failureKind = error == null ? null : workspaceGitFailureKind(error);
  logWarn("repo_policy_snapshot_unavailable", {
    reason,
    ...(baseSha ? { baseSha } : {}),
    ...(failureKind ? { failureKind } : {}),
  });
  return baseSha ? { kind: "unavailable", reason, baseSha } : { kind: "unavailable", reason };
}

function perFileCap(path: string): number {
  return INSTRUCTION_FILENAMES.has(path)
    ? MAX_AGENT_INSTRUCTION_FILE_BYTES
    : MAX_REPO_POLICY_FILE_BYTES;
}

function parseTreeRecord(
  record: string,
): { readonly mode: string; readonly blobSha: string; readonly path: string } | null {
  const tab = record.indexOf("\t");
  if (tab <= 0) return null;
  const meta = record.slice(0, tab).split(" ");
  const mode = meta[0];
  const blobSha = meta[2];
  const path = record.slice(tab + 1);
  if (!mode || !blobSha || !path) return null;
  return { mode, blobSha, path };
}

export async function readBasePolicySnapshot(params: {
  readonly baseSha: string | undefined;
  readonly git: WorkspaceGit;
  readonly maxFetchBytes: number;
  readonly timeoutMs: number;
}): Promise<PolicySnapshot> {
  const requested = params.baseSha;
  if (requested == null || !BASE_SHA.test(requested)) {
    return unavailable("missing_base_sha", undefined);
  }
  const baseSha = requested;
  try {
    await params.git(
      [
        "-c",
        `http.lowSpeedLimit=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES}`,
        "-c",
        `http.lowSpeedTime=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS}`,
        "fetch",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        "--no-recurse-submodules",
        "origin",
        `${baseSha}:${POLICY_BASE_REF}`,
      ],
      params.timeoutMs,
    );
  } catch (error) {
    return unavailable("fetch_failed", baseSha, error);
  }

  try {
    const listed = await params.git(["ls-tree", "-r", "-z", POLICY_BASE_REF], params.timeoutMs);
    const files: PolicySnapshotFile[] = [];
    const drops: PolicySnapshotDrop[] = [];
    let allowlisted = 0;
    for (const record of listed.stdout.split("\0")) {
      if (record.length === 0) continue;
      const entry = parseTreeRecord(record);
      if (entry == null || !isAllowlistedPolicyPath(entry.path)) continue;
      allowlisted += 1;
      if (!REGULAR_FILE_MODES.has(entry.mode)) {
        drops.push({ path: entry.path, reason: "non_regular_mode" });
        continue;
      }
      const sized = await params.git(["cat-file", "-s", entry.blobSha], params.timeoutMs);
      const size = Number(sized.stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("blob size");
      }
      if (size > perFileCap(entry.path)) {
        drops.push({ path: entry.path, reason: "over_cap" });
        continue;
      }
      const body = await params.git(["cat-file", "blob", entry.blobSha], params.timeoutMs);
      files.push({ path: entry.path, blobSha: entry.blobSha, body: body.stdout });
    }
    const counted = await params.git(["count-objects", "-v"], params.timeoutMs);
    if (gitCountObjectsStoreBytes(counted.stdout) > params.maxFetchBytes) {
      return unavailable("object_store_cap", baseSha);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    drops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (allowlisted === 0) return { kind: "absent", baseSha };
    return { kind: "ok", baseSha, files, drops };
  } catch (error) {
    return unavailable("blob_read_failed", baseSha, error);
  }
}
