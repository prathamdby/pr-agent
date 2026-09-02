import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import * as v from "valibot";
import { assertPathAllowedForAsk, pathAllowedForAsk, type AskPathGate } from "../ask/askSafety.js";
import { assertWorkspacePath, type LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { CODE_INDEX_MAX_RESULTS } from "../../settings/index.js";
import { type LocalTool, toExecutor, toPiTool } from "./defineWorkspaceTool.js";
import {
  searchCodeIndexFts,
  previewForChunk,
  type CodeIndexSearchResult,
} from "../../codeIndex/search.js";

/** Stable tool surface for prompt-cache prefixes (available and unavailable share these bytes). */
export const SEARCH_CODE_INDEX_DESCRIPTION =
  "Search the optional Postgres FTS code index for navigation hints (path and line ranges). Hints only — you must call readWorkspaceFile on any match before citing path or line numbers in findings. When the index is unavailable for this run, the tool returns { unavailable: true }; use listChangedFiles, searchWorkspace, and readWorkspaceFile instead.";

export const searchCodeIndexSchema = v.object({
  query: v.pipe(v.string(), v.minLength(1)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), CODE_INDEX_MAX_RESULTS),
});

async function linesForChunkVerification(
  workspace: LocalPrWorkspace,
  path: string,
): Promise<string[] | null> {
  const normalized = path.replace(/\\/g, "/");
  if (!workspace.isPathInCheckout(normalized)) return null;
  const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
  const content = await readFile(safePath, "utf8").catch(() => null);
  if (content == null) return null;
  return content.split("\n");
}

function toCodeIndexBundle(tool: LocalTool): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const tools = { searchCodeIndex: tool };
  return {
    piTools: Object.entries(tools).map(([name, entry]) => toPiTool(name, entry)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, entry]) => [name, toExecutor(name, entry)]),
    ),
  };
}

export function buildCodeIndexTools(params: {
  readonly pool: Pool;
  readonly snapshotId: string;
  readonly workspace: LocalPrWorkspace;
  readonly pathGate: AskPathGate;
}): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const allowedPaths = new Set<string>();
  for (const path of params.workspace.sortedCheckoutPaths) {
    const normalized = path.replace(/\\/g, "/");
    if (pathAllowedForAsk(normalized, params.pathGate)) {
      allowedPaths.add(normalized);
    }
  }

  return toCodeIndexBundle({
    description: SEARCH_CODE_INDEX_DESCRIPTION,
    schema: searchCodeIndexSchema,
    run: async ({ query, limit }): Promise<CodeIndexSearchResult> => {
      const rows = await searchCodeIndexFts(
        params.pool,
        params.snapshotId,
        query,
        limit,
        allowedPaths,
      );
      // One read per path: hints often cluster on the same file, and the
      // old per-row read re-read and re-split it for every hint.
      const linesByPath = new Map<string, Promise<string[] | null>>();
      const linesForPath = (path: string): Promise<string[] | null> => {
        const cached = linesByPath.get(path);
        if (cached) return cached;
        const pending = linesForChunkVerification(params.workspace, path);
        linesByPath.set(path, pending);
        return pending;
      };
      const verifiedRows = await Promise.all(
        rows.map(async (row) => {
          try {
            assertPathAllowedForAsk(row.path, params.pathGate);
            const lines = await linesForPath(row.path);
            if (lines == null) return { row, hashOk: false };
            const slice = lines.slice(row.start_line - 1, row.end_line).join("\n");
            const hashOk = createHash("sha256").update(slice).digest().equals(row.content_hash);
            return { row, hashOk };
          } catch {
            return { row, hashOk: false };
          }
        }),
      );
      const hints = verifiedRows.map(({ row, hashOk }) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        ...(hashOk ? { preview: previewForChunk(row.content) } : {}),
      }));
      return { hints };
    },
  });
}

export function buildUnavailableCodeIndexTools(): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  return toCodeIndexBundle({
    description: SEARCH_CODE_INDEX_DESCRIPTION,
    schema: searchCodeIndexSchema,
    run: async (): Promise<CodeIndexSearchResult> => ({ unavailable: true }),
  });
}
