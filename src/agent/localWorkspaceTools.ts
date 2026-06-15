import { readFile } from "node:fs/promises";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";
import { assertWorkspacePath } from "../prWorkspace/localPrWorkspace.js";
import {
  assertPathAllowedForAsk,
  createAskPathGate,
  pathAllowedForAsk,
  redactPorcelainBlame,
  sanitizeToolResultForAsk,
  type AskPathGate,
} from "./askSafety.js";
import { defineLocalTool, defineLocalToolBundle } from "./localToolBundle.js";
import {
  defineGetWorkspaceDiffTool,
  defineReadWorkspaceFileTool,
  defineSearchWorkspaceTool,
  looksBinary,
  statTextFileForRead,
} from "./workspaceReaderTools.js";

export type LocalWorkspaceToolLimits = {
  readonly maxFileBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxTotalBytes: number;
};

export function workspaceToolLimitsFromConfig(cfg: Config): LocalWorkspaceToolLimits {
  return {
    maxFileBytes: cfg.localWorkspaceMaxFileBytes,
    searchMaxFiles: cfg.localWorkspaceSearchMaxFiles,
    searchMaxTotalBytes: cfg.localWorkspaceSearchMaxTotalBytes,
  };
}

function primePathGate(
  workspace: LocalPrWorkspace,
  pathGate: AskPathGate,
  extraAllowedPaths?: readonly string[],
): void {
  pathGate.addPaths(workspace.changedFiles.map((file) => file.path));
  if (extraAllowedPaths?.length) {
    pathGate.addPaths(extraAllowedPaths);
  }
}

function changedFileForPath(workspace: LocalPrWorkspace, path: string) {
  return workspace.changedFileByPath.get(path.replace(/\\/g, "/"));
}

async function refuseUnlessReadableFile(
  workspace: LocalPrWorkspace,
  normalized: string,
  limits: LocalWorkspaceToolLimits,
): Promise<{ refused: true; reason: string } | null> {
  if (!workspace.isPathInCheckout(normalized)) {
    return {
      refused: true,
      reason: "Path is missing from the checkout.",
    };
  }
  const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
  const statResult = await statTextFileForRead(safePath, limits.maxFileBytes);
  if ("refused" in statResult) {
    return statResult;
  }
  return null;
}

export function buildLocalWorkspaceTools(
  workspace: LocalPrWorkspace,
  limits: LocalWorkspaceToolLimits,
  opts?: {
    readonly pathGate?: AskPathGate;
    readonly extraAllowedPaths?: readonly string[];
  },
): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const pathGate = opts?.pathGate ?? createAskPathGate();
  primePathGate(workspace, pathGate, opts?.extraAllowedPaths);

  const listChangedFiles = defineLocalTool({
    description: "List files changed in this pull request from the local PR workspace.",
    schema: z.object({}),
    run: async () => ({
      files: workspace.changedFiles.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        presentInCheckout: workspace.checkoutPaths.has(file.path),
      })),
      truncated: workspace.stats.truncated,
      ...(workspace.stats.warning ? { warning: workspace.stats.warning } : {}),
    }),
  });

  const readWorkspaceFile = defineReadWorkspaceFileTool(
    "Read a text file from the local PR workspace checkout. Paths are relative to the repository root.",
    async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, content: null };
      }
      const refused = await refuseUnlessReadableFile(workspace, normalized, limits);
      if (refused) {
        return { path: normalized, ...refused };
      }
      const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
      const buf = await readFile(safePath);
      if (looksBinary(buf.subarray(0, Math.min(buf.length, 8192)))) {
        return {
          path: normalized,
          refused: true,
          reason: "Binary file cannot be read as text.",
        };
      }
      return {
        path: normalized,
        size: buf.length,
        content: buf.toString("utf8"),
      };
    },
  );

  const searchWorkspace = defineSearchWorkspaceTool(
    "Search the full local PR workspace checkout with git grep for a literal string. Skips binary files. filesScanned is the matched file count after path filtering.",
    async ({ query, maxResults }) => {
      const allowedPaths = workspace.sortedCheckoutPaths.filter((path) =>
        pathAllowedForAsk(path, pathGate),
      );
      if (allowedPaths.length === 0) {
        return { matches: [], truncated: false, filesScanned: 0 };
      }
      const result = await workspace.grepLiteral({
        query,
        maxResults,
        maxOutputBytes: limits.searchMaxTotalBytes,
        paths: allowedPaths,
      });
      const matchedFiles = new Set(result.matches.map((match) => match.path));
      return {
        matches: result.matches.slice(0, maxResults),
        truncated: result.truncated || result.matches.length > maxResults,
        filesScanned: matchedFiles.size,
      };
    },
  );

  const getWorkspaceDiff = defineGetWorkspaceDiffTool(
    "Return the PR unified diff for a changed path (from GitHub PR file metadata).",
    async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      return {
        path: normalized,
        diff: await workspace.getDiffForPath(normalized),
      };
    },
  );

  const getWorkspaceBlame = defineLocalTool({
    description: "Return best-effort local git blame for a workspace path at PR head.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, blame: null };
      }
      const refused = await refuseUnlessReadableFile(workspace, normalized, limits);
      if (refused) {
        return { path: normalized, ...refused, blame: null };
      }
      const blame = redactPorcelainBlame(await workspace.getBlameForPath(normalized));
      return sanitizeToolResultForAsk("getWorkspaceBlame", {
        path: normalized,
        blame,
      });
    },
  });

  return defineLocalToolBundle({
    listChangedFiles,
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
    getWorkspaceBlame,
  });
}
