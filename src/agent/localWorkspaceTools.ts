import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { LocalPrWorkspace } from "../agentWork/localPrWorkspace.js";
import { assertWorkspacePath } from "../agentWork/localPrWorkspace.js";

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

export function buildLocalWorkspaceTools(workspace: LocalPrWorkspace): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
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
      const changed = workspace.changedFiles.find((file) => file.path === path);
      if (changed?.status === "deleted") {
        return { path, deleted: true, content: null };
      }
      await workspace.materializePath(path);
      const safePath = assertWorkspacePath(workspace.agentCwd, path);
      const info = await stat(safePath);
      const content = await readFile(safePath, "utf8");
      return { path, size: info.size, content };
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
    run: async ({ path }) => ({ path, diff: await workspace.getDiffForPath(path) }),
  };

  const getWorkspaceBlame: LocalTool = {
    description:
      "Best-effort blame is not available in the initial local workspace tool surface; use diff context instead.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => ({
      path,
      unavailable: true,
      reason: "Blame requires bounded history deepening and will be added after local diff parity.",
    }),
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
