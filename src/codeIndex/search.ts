import type { Pool, PoolClient } from "pg";
import { CODE_INDEX_MAX_RESULTS, CODE_INDEX_PREVIEW_MAX_CHARS } from "../settings/index.js";

export type CodeIndexSearchHint = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly preview?: string;
};

export type CodeIndexSearchResult =
  | { readonly hints: readonly CodeIndexSearchHint[] }
  | { readonly unavailable: true };

type SearchRow = {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: Buffer;
};

export async function searchCodeIndexFts(
  pool: Pool | PoolClient,
  snapshotId: string,
  query: string,
  limit = CODE_INDEX_MAX_RESULTS,
  allowedPaths?: ReadonlySet<string>,
): Promise<readonly SearchRow[]> {
  const { rows } = await pool.query<SearchRow>(
    `WITH q AS (SELECT plainto_tsquery('english', $2) AS tsq)
     SELECT c.path, c.start_line, c.end_line, c.content, c.content_hash
       FROM code_index_chunks c
       CROSS JOIN q
      WHERE c.snapshot_id = $1
        AND c.tsv @@ q.tsq
      ORDER BY ts_rank(c.tsv, q.tsq) DESC
      LIMIT $3`,
    [snapshotId, query, limit * 4],
  );

  const hints: SearchRow[] = [];
  for (const row of rows) {
    if (allowedPaths && !allowedPaths.has(row.path)) continue;
    hints.push(row);
    if (hints.length >= limit) break;
  }
  return hints;
}

export function previewForChunk(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= CODE_INDEX_PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, CODE_INDEX_PREVIEW_MAX_CHARS)}…`;
}

export function mapSearchRowsToHints(
  rows: readonly SearchRow[],
  verifyContent?: (path: string, contentHash: Buffer, row: SearchRow) => boolean,
): readonly CodeIndexSearchHint[] {
  return rows.map((row) => {
    const hashOk = verifyContent?.(row.path, row.content_hash, row) ?? true;
    return {
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      ...(hashOk ? { preview: previewForChunk(row.content) } : {}),
    };
  });
}
