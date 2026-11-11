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
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: "1" } as const;

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
  io?: { readonly stdin?: Buffer | string; readonly extraEnv?: Record<string, string> },
) => Promise<{ readonly stdout: string; readonly stdoutBuffer?: Buffer }>;

type TreeCandidate = {
  readonly path: string;
  readonly blobSha: string;
};

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

function byPath<T extends { readonly path: string }>(left: T, right: T): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function oidStdin(oids: readonly string[]): string {
  return `${oids.join("\n")}\n`;
}

function uniqueOids(candidates: readonly TreeCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.blobSha))];
}

function parseBatchCheckSizes(stdout: string, oids: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[1] !== "blob") throw new Error("blob size");
    const sha = parts[0];
    const size = Number(parts[2]);
    if (!sha || !Number.isSafeInteger(size) || size < 0) throw new Error("blob size");
    sizes.set(sha, size);
  }
  for (const oid of oids) {
    if (!sizes.has(oid)) throw new Error("blob size");
  }
  return sizes;
}

function parseBatchBodies(stdout: Buffer, oids: readonly string[]): Map<string, Buffer> {
  const bodies = new Map<string, Buffer>();
  let offset = 0;
  for (const expectedSha of oids) {
    const nl = stdout.indexOf(0x0a, offset);
    if (nl < 0) throw new Error("blob body");
    const header = stdout.subarray(offset, nl).toString("utf8");
    const parts = header.split(" ");
    if (parts.length !== 3 || parts[0] !== expectedSha || parts[1] !== "blob") {
      throw new Error("blob body");
    }
    const byteLength = Number(parts[2]);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("blob body");
    const start = nl + 1;
    const end = start + byteLength;
    if (end > stdout.length || stdout[end] !== 0x0a) throw new Error("blob body");
    bodies.set(expectedSha, stdout.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== stdout.length) throw new Error("blob body");
  return bodies;
}

const POLICY_FETCH_FLAGS = [
  "-c",
  `http.lowSpeedLimit=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES}`,
  "-c",
  `http.lowSpeedTime=${LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS}`,
] as const;

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
        ...POLICY_FETCH_FLAGS,
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
    const drops: PolicySnapshotDrop[] = [];
    const candidates: TreeCandidate[] = [];
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
      candidates.push({ path: entry.path, blobSha: entry.blobSha });
    }

    const prefetchOids = uniqueOids(candidates);
    if (prefetchOids.length > 0) {
      await params.git(
        [
          ...POLICY_FETCH_FLAGS,
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "origin",
          "--stdin",
        ],
        params.timeoutMs,
        { stdin: oidStdin(prefetchOids) },
      );
    }

    const counted = await params.git(["count-objects", "-v"], params.timeoutMs);
    if (gitCountObjectsStoreBytes(counted.stdout) > params.maxFetchBytes) {
      return unavailable("object_store_cap", baseSha);
    }
    if (allowlisted === 0) return { kind: "absent", baseSha };
    if (candidates.length === 0) {
      drops.sort(byPath);
      return { kind: "ok", baseSha, files: [], drops };
    }

    const checked = await params.git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      params.timeoutMs,
      { stdin: oidStdin(prefetchOids), extraEnv: NO_LAZY_FETCH },
    );
    const sizes = parseBatchCheckSizes(checked.stdout, prefetchOids);
    const inCap: TreeCandidate[] = [];
    for (const candidate of candidates) {
      const size = sizes.get(candidate.blobSha);
      if (size == null) throw new Error("blob size");
      if (size > perFileCap(candidate.path)) {
        drops.push({ path: candidate.path, reason: "over_cap" });
        continue;
      }
      inCap.push(candidate);
    }

    const files: PolicySnapshotFile[] = [];
    const batchOids = uniqueOids(inCap);
    if (batchOids.length > 0) {
      const batched = await params.git(["cat-file", "--batch"], params.timeoutMs, {
        stdin: oidStdin(batchOids),
        extraEnv: NO_LAZY_FETCH,
      });
      const stdout = batched.stdoutBuffer;
      if (stdout == null) throw new Error("blob body");
      const bodies = parseBatchBodies(stdout, batchOids);
      for (const candidate of inCap) {
        const body = bodies.get(candidate.blobSha);
        if (body == null) throw new Error("blob body");
        files.push({
          path: candidate.path,
          blobSha: candidate.blobSha,
          body: body.toString("utf8"),
        });
      }
    }

    files.sort(byPath);
    drops.sort(byPath);
    return { kind: "ok", baseSha, files, drops };
  } catch (error) {
    return unavailable("blob_read_failed", baseSha, error);
  }
}
