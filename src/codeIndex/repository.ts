import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.js";
import { logWarn } from "../evlog.js";
import { CODE_INDEX_CHUNKER_VERSION } from "../settings/index.js";
import type { CodeIndexChunk } from "./chunker.js";

type CodeIndexSnapshotStatus = "building" | "ready" | "failed" | "superseded";

export type CodeIndexRepoScope = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
};

type CodeIndexSnapshot = {
  readonly id: string;
  readonly status: CodeIndexSnapshotStatus;
  readonly chunkerVersion: string;
};

function mapSnapshot(row: {
  id: string;
  status: CodeIndexSnapshotStatus;
  chunker_version: string;
}): CodeIndexSnapshot {
  return {
    id: row.id,
    status: row.status,
    chunkerVersion: row.chunker_version,
  };
}

async function getReadySnapshot(
  pool: Pool | PoolClient,
  scope: CodeIndexRepoScope,
): Promise<CodeIndexSnapshot | null> {
  const { rows } = await pool.query<{
    id: string;
    status: CodeIndexSnapshotStatus;
    chunker_version: string;
  }>(
    `SELECT id, status, chunker_version
       FROM code_index_snapshots
      WHERE installation_id = $1
        AND owner = $2
        AND repo = $3
        AND head_sha = $4
        AND status = 'ready'
      LIMIT 1`,
    [scope.installationId, scope.owner, scope.repo, scope.headSha],
  );
  const row = rows[0];
  return row ? mapSnapshot(row) : null;
}

export async function ensureBuildingSnapshot(
  pool: Pool | PoolClient,
  scope: CodeIndexRepoScope,
): Promise<CodeIndexSnapshot> {
  await pool.query(
    `UPDATE code_index_snapshots
        SET status = 'superseded', updated_at = now()
      WHERE installation_id = $1
        AND owner = $2
        AND repo = $3
        AND head_sha <> $4
        AND status IN ('building', 'ready')`,
    [scope.installationId, scope.owner, scope.repo, scope.headSha],
  );

  const { rows } = await pool.query<{
    id: string;
    status: CodeIndexSnapshotStatus;
    chunker_version: string;
  }>(
    `INSERT INTO code_index_snapshots (
       installation_id, owner, repo, head_sha, status, chunker_version
     ) VALUES ($1, $2, $3, $4, 'building', $5)
     ON CONFLICT (installation_id, owner, repo, head_sha)
     DO UPDATE SET
       status = CASE
         WHEN code_index_snapshots.status = 'ready'
          AND code_index_snapshots.chunker_version = EXCLUDED.chunker_version
         THEN 'ready'
         ELSE 'building'
       END,
       chunker_version = EXCLUDED.chunker_version,
       updated_at = now()
     RETURNING id, status, chunker_version`,
    [scope.installationId, scope.owner, scope.repo, scope.headSha, CODE_INDEX_CHUNKER_VERSION],
  );
  const row = rows[0];
  if (!row) {
    throw new AppError({
      code: "code_index.snapshot_upsert_failed",
      message: "INSERT did not return a snapshot row",
    });
  }
  return mapSnapshot(row);
}

export async function getSnapshotById(
  pool: Pool | PoolClient,
  snapshotId: string,
): Promise<CodeIndexSnapshot | null> {
  const { rows } = await pool.query<{
    id: string;
    status: CodeIndexSnapshotStatus;
    chunker_version: string;
  }>(
    `SELECT id, status, chunker_version
       FROM code_index_snapshots
      WHERE id = $1
      LIMIT 1`,
    [snapshotId],
  );
  const row = rows[0];
  return row ? mapSnapshot(row) : null;
}

export async function replaceSnapshotChunks(
  pool: Pool | PoolClient,
  snapshotId: string,
  chunks: readonly CodeIndexChunk[],
): Promise<void> {
  await pool.query("DELETE FROM code_index_chunks WHERE snapshot_id = $1", [snapshotId]);
  if (chunks.length === 0) return;

  const batchSize = 200;
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((chunk, index) => {
      const base = index * 7;
      values.push(
        snapshotId,
        chunk.path,
        chunk.startLine,
        chunk.endLine,
        chunk.symbolNames,
        chunk.content,
        chunk.contentHash,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO code_index_chunks (
         snapshot_id, path, start_line, end_line, symbol_names, content, content_hash
       ) VALUES ${placeholders.join(", ")}`,
      values,
    );
  }
}

export async function markSnapshotReady(
  pool: Pool | PoolClient,
  snapshotId: string,
): Promise<void> {
  await pool.query(
    `UPDATE code_index_snapshots
        SET status = 'ready', updated_at = now()
      WHERE id = $1`,
    [snapshotId],
  );
}

export async function markSnapshotFailed(
  pool: Pool | PoolClient,
  snapshotId: string,
): Promise<void> {
  await pool.query(
    `UPDATE code_index_snapshots
        SET status = 'failed', updated_at = now()
      WHERE id = $1`,
    [snapshotId],
  );
}

export async function waitForReadySnapshot(
  pool: Pool,
  scope: CodeIndexRepoScope,
  waitMs: number,
  pollMs = 100,
): Promise<CodeIndexSnapshot | null> {
  if (waitMs <= 0) return getReadySnapshot(pool, scope);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const snapshot = await getReadySnapshot(pool, scope);
    if (snapshot) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return getReadySnapshot(pool, scope);
}

export async function deleteExpiredCodeIndexSnapshots(
  pool: Pool,
  retentionSeconds: number,
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM code_index_snapshots
        WHERE id IN (
          SELECT id FROM code_index_snapshots
           WHERE status IN ('superseded', 'failed', 'ready')
             AND updated_at < now() - ($1::bigint * interval '1 second')
           LIMIT $2::int
        )`,
      [retentionSeconds, batchSize],
    );
    const batch = result.rowCount ?? 0;
    deleted += batch;
    if (batch < batchSize) break;
  }
  return deleted;
}

export async function safeDeleteExpiredCodeIndexSnapshots(
  pool: Pool,
  retentionSeconds: number,
  batchSize: number,
): Promise<number> {
  try {
    return await deleteExpiredCodeIndexSnapshots(pool, retentionSeconds, batchSize);
  } catch (error) {
    logWarn("code_index_retention_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
