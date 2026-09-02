import { readFile, stat } from "node:fs/promises";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import { mintInstallationToken } from "../agentWork/durableJob.js";
import { createPrSurface } from "../github/prSurface.js";
import { assertWorkspacePath, type LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";
import { withPrRepositoryView } from "../prWorkspace/prRepositoryView.js";
import { isIndexableSourcePath } from "../prWorkspace/symbolIndex.js";
import { pathAllowedForAsk, type AskPathGate } from "../agent/ask/askSafety.js";
import {
  CODE_INDEX_BUILD_QUEUE,
  CODE_INDEX_MAX_CHUNKS_PER_REPO,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
} from "../settings/index.js";
import { chunkFiles } from "./chunker.js";
import {
  ensureBuildingSnapshot,
  getSnapshotById,
  markSnapshotFailed,
  markSnapshotReady,
  replaceSnapshotChunks,
  type CodeIndexRepoScope,
  waitForReadySnapshot,
} from "./repository.js";

const BINARY_SAMPLE_BYTES = 8192;

export type CodeIndexBuildJobData = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
};

export type CodeIndexPrepareResult =
  | { readonly available: true; readonly snapshotId: string }
  | { readonly available: false };

function codeIndexSingletonKey(scope: CodeIndexRepoScope): string {
  return `code-index:${scope.installationId}:${scope.owner}/${scope.repo}:${scope.headSha}`;
}

function pathAllowedForIndexing(
  path: string,
  workspace: LocalPrWorkspace,
  pathGate: AskPathGate,
): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!workspace.isPathInCheckout(normalized)) return false;
  if (!isIndexableSourcePath(normalized)) return false;
  return pathAllowedForAsk(normalized, pathGate);
}

async function readIndexableWorkspaceFile(
  workspace: LocalPrWorkspace,
  path: string,
): Promise<string | null> {
  const normalized = path.replace(/\\/g, "/");
  const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
  const info = await stat(safePath).catch(() => null);
  if (!info?.isFile() || info.size > LOCAL_WORKSPACE_MAX_FILE_BYTES) return null;
  const buf = await readFile(safePath).catch(() => null);
  if (!buf) return null;
  if (buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)).includes(0)) return null;
  return buf.toString("utf8");
}

export async function buildCodeIndexFromWorkspace(
  pool: Pool,
  scope: CodeIndexRepoScope,
  workspace: LocalPrWorkspace,
  pathGate: AskPathGate,
): Promise<void> {
  const snapshot = await ensureBuildingSnapshot(pool, scope);
  if (snapshot.status === "ready") return;

  const client = await pool.connect();
  let unlockError: unknown;
  try {
    // Serialize inline + worker builders for the same snapshot.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [snapshot.id]);
    try {
      const current = await getSnapshotById(client, snapshot.id);
      if (!current || current.status === "ready") return;

      try {
        const files: Array<{ path: string; content: string }> = [];
        for (const path of workspace.sortedCheckoutPaths) {
          if (!pathAllowedForIndexing(path, workspace, pathGate)) continue;
          const content = await readIndexableWorkspaceFile(workspace, path);
          if (content == null) continue;
          files.push({ path, content });
        }
        const { chunks } = chunkFiles(files, CODE_INDEX_MAX_CHUNKS_PER_REPO);
        await replaceSnapshotChunks(client, snapshot.id, chunks);
        await markSnapshotReady(client, snapshot.id);
      } catch (error) {
        await markSnapshotFailed(client, snapshot.id).catch(() => undefined);
        throw error;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [
          snapshot.id,
        ]);
      } catch (error) {
        unlockError = error;
        logWarn("code_index_unlock_failed", {
          snapshotId: snapshot.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    client.release(unlockError !== undefined ? true : undefined);
  }
}

export async function enqueueCodeIndexBuildJob(
  boss: PgBoss,
  data: CodeIndexBuildJobData,
): Promise<void> {
  const scope: CodeIndexRepoScope = {
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
  };
  await boss.createQueue(CODE_INDEX_BUILD_QUEUE, { policy: "standard" });
  await boss.send(CODE_INDEX_BUILD_QUEUE, data, {
    singletonKey: codeIndexSingletonKey(scope),
    expireInSeconds: 3600,
  });
}

export async function executeCodeIndexBuildJob(
  cfg: Config,
  pool: Pool,
  data: CodeIndexBuildJobData,
): Promise<void> {
  if (cfg.codeIndexMode !== "fts") return;

  const scope: CodeIndexRepoScope = {
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
  };
  const existing = await waitForReadySnapshot(pool, scope, 0);
  if (existing) return;

  const installation = await mintInstallationToken(cfg, data.installationId);
  const prSurface = createPrSurface({
    cfg,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    installation,
  });
  await withPrRepositoryView(
    {
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      headSha: data.headSha,
      gitCredentialAuth: () => prSurface.gitCredentialAuth(),
    },
    async (view) => {
      const pathGate = {
        prChangedPaths: new Set(view.workspace.changedFiles.map((file) => file.path)),
        addPaths: () => undefined,
      };
      await buildCodeIndexFromWorkspace(pool, scope, view.workspace, pathGate);
    },
  );
}

export async function prepareCodeIndexForReview(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss?: PgBoss;
  readonly scope: CodeIndexRepoScope & { readonly prNumber: number };
  readonly workspace: LocalPrWorkspace;
  readonly pathGate: AskPathGate;
}): Promise<CodeIndexPrepareResult> {
  if (args.cfg.codeIndexMode !== "fts") return { available: false };

  const ready = await waitForReadySnapshot(args.pool, args.scope, 0);
  if (ready) return { available: true, snapshotId: ready.id };

  const snapshot = await ensureBuildingSnapshot(args.pool, args.scope);
  if (snapshot.status === "ready") {
    return { available: true, snapshotId: snapshot.id };
  }

  const buildPromise = buildCodeIndexFromWorkspace(
    args.pool,
    args.scope,
    args.workspace,
    args.pathGate,
  ).catch((error) => {
    logWarn("code_index_inline_build_failed", {
      owner: args.scope.owner,
      repo: args.scope.repo,
      headSha: args.scope.headSha,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  if (args.boss) {
    await enqueueCodeIndexBuildJob(args.boss, {
      installationId: args.scope.installationId,
      owner: args.scope.owner,
      repo: args.scope.repo,
      prNumber: args.scope.prNumber,
      headSha: args.scope.headSha,
    }).catch((error) => {
      logWarn("code_index_enqueue_failed", {
        owner: args.scope.owner,
        repo: args.scope.repo,
        headSha: args.scope.headSha,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await Promise.race([
    buildPromise,
    new Promise((resolve) => setTimeout(resolve, args.cfg.codeIndexWaitMs)),
  ]);

  const afterWait = await waitForReadySnapshot(args.pool, args.scope, 0);
  if (afterWait) return { available: true, snapshotId: afterWait.id };
  return { available: false };
}

export function formatCodeIndexStatusLine(result: CodeIndexPrepareResult): string {
  if (!result.available) return "Code index: unavailable.";
  return "Code index: FTS hints available (readWorkspaceFile required before citing).";
}
