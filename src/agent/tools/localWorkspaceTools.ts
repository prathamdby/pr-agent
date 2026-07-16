import { readFile, stat } from "node:fs/promises";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { assertWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import {
  assertPathAllowedForAsk,
  createAskPathGate,
  pathAllowedForAsk,
  redactPorcelainBlame,
  sanitizeToolResultForAsk,
  type AskPathGate,
} from "../ask/askSafety.js";
import { type LocalTool, toExecutor, toPiTool } from "./defineWorkspaceTool.js";
import { capTextOutput, readTextWithOutputBudget } from "./toolOutputBudget.js";

export type LocalWorkspaceToolLimits = {
  readonly maxFileBytes: number;
  readonly readResponseBytes: number;
  readonly diffResponseBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxTotalBytes: number;
};

export function workspaceToolLimitsFromConfig(cfg: Config): LocalWorkspaceToolLimits {
  return {
    maxFileBytes: cfg.localWorkspaceMaxFileBytes,
    readResponseBytes: cfg.localWorkspaceReadResponseBytes,
    diffResponseBytes: cfg.localWorkspaceDiffResponseBytes,
    searchMaxFiles: cfg.localWorkspaceSearchMaxFiles,
    searchMaxTotalBytes: cfg.localWorkspaceSearchMaxTotalBytes,
  };
}

const BINARY_SAMPLE_BYTES = 8192;

function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
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
  const info = await stat(safePath).catch(() => null);
  if (!info?.isFile()) {
    return {
      refused: true,
      reason: "Path is missing from the checkout.",
    };
  }
  if (info.size > limits.maxFileBytes) {
    return {
      refused: true,
      reason: `File exceeds ${limits.maxFileBytes} byte read limit.`,
    };
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

  const listChangedFiles: LocalTool = {
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
  };

  const readWorkspaceFile: LocalTool = {
    description:
      "Read a text file from the local PR workspace checkout. Paths are relative to the repository root. Responses are capped; use startLine and maxLines for focused follow-up reads.",
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    run: async ({ path, startLine, maxLines }) => {
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
      if (looksBinary(buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)))) {
        return {
          path: normalized,
          refused: true,
          reason: "Binary file cannot be read as text.",
        };
      }
      const text = buf.toString("utf8");
      return {
        path: normalized,
        ...readTextWithOutputBudget(text, limits.readResponseBytes, { startLine, maxLines }),
      };
    },
  };

  const searchWorkspace: LocalTool = {
    description:
      "Search the full local PR workspace checkout with git grep for a literal string. Skips binary files. filesScanned is the matched file count after path filtering.",
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional().default(20),
    }),
    run: async ({ query, maxResults }) => {
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
  };

  const getWorkspaceDiff: LocalTool = {
    description:
      "Return the PR unified diff for a changed path (from GitHub PR file metadata). Responses are capped; narrow the path or follow up with a focused file read when truncated.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      const diff = await workspace.getDiffForPath(normalized);
      const capped = capTextOutput(diff, limits.diffResponseBytes, "response byte budget exceeded");
      return {
        path: normalized,
        diff: capped.content,
        truncated: capped.truncated,
        returnedBytes: capped.returnedBytes,
        ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
      };
    },
  };

  const getWorkspaceBlame: LocalTool = {
    description:
      "Return best-effort local git blame for a workspace path at PR head. Responses are capped; use startLine and maxLines on readWorkspaceFile for focused follow-up context.",
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
      const capped = capTextOutput(
        blame,
        limits.diffResponseBytes,
        "response byte budget exceeded",
      );
      return sanitizeToolResultForAsk("getWorkspaceBlame", {
        path: normalized,
        blame: capped.content,
        truncated: capped.truncated,
        returnedBytes: capped.returnedBytes,
        ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
      });
    },
  };

  const tools: Record<string, LocalTool> = {
    listChangedFiles,
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
    getWorkspaceBlame,
  };
  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(tool)]),
    ),
  };
}
