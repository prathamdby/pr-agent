import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { LocalPrWorkspace } from "../prWorkspace/localPrWorkspace.js";
import { assertWorkspacePath } from "../prWorkspace/localPrWorkspace.js";
import {
  assertPathAllowedForAsk,
  createAskPathGate,
  redactPorcelainBlame,
  sanitizeToolResultForAsk,
  type AskPathGate,
} from "./askSafety.js";

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

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  }
  await walk(root);
  return out;
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

export function buildLocalWorkspaceTools(
  workspace: LocalPrWorkspace,
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
        materialized: workspace.materializedPaths.has(file.path),
      })),
    }),
  };

  const readWorkspaceFile: LocalTool = {
    description:
      "Read a text file from the local PR workspace. Paths are relative to the repository root.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, content: null };
      }
      const materialized = await workspace.materializePath(normalized);
      if (materialized === "refused") {
        return {
          path: normalized,
          refused: true,
          reason: "Path is outside changed files or exceeds workspace materialization limits.",
        };
      }
      const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
      const info = await stat(safePath);
      const content = await readFile(safePath, "utf8");
      return { path: normalized, size: info.size, content };
    },
  };

  const searchWorkspace: LocalTool = {
    description: "Search materialized local PR workspace files for a literal string.",
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional().default(20),
    }),
    run: async ({ query, maxResults }) => {
      const files = await walkFiles(workspace.agentCwd);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const path of files) {
        const content = await readFile(assertWorkspacePath(workspace.agentCwd, path), "utf8").catch(
          () => "",
        );
        const lines = content.split("\n");
        for (const [index, line] of lines.entries()) {
          if (!line.includes(query)) continue;
          matches.push({ path, line: index + 1, text: line });
          if (matches.length >= maxResults) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    },
  };

  const getWorkspaceDiff: LocalTool = {
    description: "Return the local git diff for a changed path.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      return { path: normalized, diff: await workspace.getDiffForPath(normalized) };
    },
  };

  const getWorkspaceBlame: LocalTool = {
    description: "Return best-effort local git blame for a workspace path.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      assertPathAllowedForAsk(normalized, pathGate);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, blame: null };
      }
      const materialized = await workspace.materializePath(normalized);
      if (materialized === "refused") {
        return {
          path: normalized,
          refused: true,
          reason: "Path is outside changed files or exceeds workspace materialization limits.",
          blame: null,
        };
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
