import { readFile, stat } from "node:fs/promises";
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

type LocalTool<TSchema extends z.ZodType = z.ZodType> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: any) => Promise<unknown>;
};

function toPiTool(name: string, t: LocalTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, { unrepresentable: "any" }) as PiTool["parameters"],
  };
}

function toExecutor(t: LocalTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
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
  return workspace.changedFiles.find((file) => file.path === path.replace(/\\/g, "/"));
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
      "Read a text file from the local PR workspace checkout. Paths are relative to the repository root.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
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
      return { path: normalized, size: buf.length, content: buf.toString("utf8") };
    },
  };

  const searchWorkspace: LocalTool = {
    description:
      "Search the full local PR workspace checkout for a literal string. Skips binary and oversized files.",
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional().default(20),
    }),
    run: async ({ query, maxResults }) => {
      const files = [...workspace.checkoutPaths].toSorted();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let filesScanned = 0;
      let bytesScanned = 0;

      for (const path of files) {
        if (matches.length >= maxResults) {
          return { matches, truncated: true, filesScanned };
        }
        if (filesScanned >= limits.searchMaxFiles) {
          return {
            matches,
            truncated: true,
            filesScanned,
            reason: `Stopped after scanning ${limits.searchMaxFiles} files.`,
          };
        }

        if (!pathAllowedForAsk(path, pathGate)) {
          continue;
        }

        const safePath = assertWorkspacePath(workspace.agentCwd, path);
        let info;
        try {
          info = await stat(safePath);
        } catch {
          continue;
        }
        if (!info.isFile() || info.size > limits.maxFileBytes) continue;

        if (bytesScanned + info.size > limits.searchMaxTotalBytes) {
          return {
            matches,
            truncated: true,
            filesScanned,
            reason: `Stopped after ${limits.searchMaxTotalBytes} bytes scanned.`,
          };
        }
        bytesScanned += info.size;
        filesScanned++;

        const buf = await readFile(safePath).catch(() => Buffer.alloc(0));
        if (looksBinary(buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)))) continue;
        const content = buf.toString("utf8");
        const lines = content.split("\n");
        for (const [index, line] of lines.entries()) {
          if (!line.includes(query)) continue;
          matches.push({ path, line: index + 1, text: line });
          if (matches.length >= maxResults) {
            return { matches, truncated: true, filesScanned };
          }
        }
      }
      return { matches, truncated: false, filesScanned };
    },
  };

  const getWorkspaceDiff: LocalTool = {
    description: "Return the PR unified diff for a changed path (from GitHub PR file metadata).",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      return { path: normalized, diff: await workspace.getDiffForPath(normalized) };
    },
  };

  const getWorkspaceBlame: LocalTool = {
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
      return sanitizeToolResultForAsk("getWorkspaceBlame", { path: normalized, blame });
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
