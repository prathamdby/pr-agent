import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import type { WritablePrCheckout } from "../prWorkspace/writablePrCheckout.js";
import { assertWorkspacePath } from "../prWorkspace/localPrWorkspace.js";
import { SENSITIVE_PATH_PATTERNS, TRIAGE_NEW_FILE_MAX_BYTES } from "../settings/index.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";

const exec = promisify(execFile);

type LocalTool<TSchema extends z.ZodType = z.ZodType> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: z.infer<TSchema>) => Promise<unknown>;
};

export type TriageWorkspaceToolState = {
  readonly commitByThreadRootCommentId: Map<number, string>;
};

function toPiTool(name: string, t: LocalTool): PiTool {
  return {
    name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };
}

function toExecutor(t: LocalTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => t.run(t.schema.parse(args));
}

function defineLocalTool<TSchema extends z.ZodType>(tool: LocalTool<TSchema>): LocalTool<TSchema> {
  return tool;
}

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function safePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (isSensitivePath(normalized)) throw new Error(`Blocked sensitive path "${normalized}"`);
  return assertWorkspacePath(root, normalized);
}

function relativePath(root: string, fullPath: string): string {
  return relative(root, fullPath).replace(/\\/g, "/");
}

async function readTextFile(root: string, path: string, maxBytes: number) {
  const fullPath = safePath(root, path);
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile()) return { path, refused: true, reason: "Path is missing from checkout" };
  if (info.size > maxBytes) return { path, refused: true, reason: "File exceeds read limit" };
  const content = await readFile(fullPath, "utf8");
  return { path, size: info.size, content };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) return count;
    count++;
    offset = found + needle.length;
  }
}

async function git(root: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    },
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export function createTriageWorkspaceToolState(): TriageWorkspaceToolState {
  return { commitByThreadRootCommentId: new Map() };
}

export function buildTriageWorkspaceTools(params: {
  readonly cfg: Config;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly state: TriageWorkspaceToolState;
}): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const inventoryIds = new Set(params.inventory.map((thread) => thread.rootCommentId));
  const root = params.checkout.dir;

  const readWorkspaceFile = defineLocalTool({
    description: "Read a text file from the writable PR checkout. Path is repo-relative.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => readTextFile(root, path, params.cfg.localWorkspaceMaxFileBytes),
  });

  const searchWorkspace = defineLocalTool({
    description: "Search the writable checkout with git grep for a literal string.",
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional().default(20),
    }),
    run: async ({ query, maxResults }) => {
      const stdout = await git(
        root,
        ["grep", "-nF", "-I", `--max-count=${maxResults + 1}`, "-e", query, "--", "."],
        params.cfg.localWorkspaceFetchTimeoutMs,
      ).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
          return "";
        }
        throw error;
      });
      const matches = stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, maxResults)
        .map((line) => {
          const first = line.indexOf(":");
          const second = line.indexOf(":", first + 1);
          return {
            path: line.slice(0, first),
            line: Number(line.slice(first + 1, second)),
            text: line.slice(second + 1),
          };
        });
      return { matches, truncated: stdout.split("\n").filter(Boolean).length > maxResults };
    },
  });

  const getWorkspaceDiff = defineLocalTool({
    description:
      "Return the current unified diff for a repo-relative path in the writable checkout.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const fullPath = safePath(root, path);
      const rel = relativePath(root, fullPath);
      const diff = await git(
        root,
        ["diff", "HEAD", "--", rel],
        params.cfg.localWorkspaceFetchTimeoutMs,
      );
      return { path: rel, diff };
    },
  });

  const editWorkspaceFile = defineLocalTool({
    description:
      "Exact-match replacement in a writable checkout file. oldText must match exactly once.",
    schema: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    run: async ({ path, oldText, newText }) => {
      const fullPath = safePath(root, path);
      const content = await readFile(fullPath, "utf8");
      const matches = countOccurrences(content, oldText);
      if (matches === 0) throw new Error("oldText not found; re-read the file");
      if (matches > 1) throw new Error("oldText is ambiguous; include more surrounding context");
      await writeFile(fullPath, content.replace(oldText, newText));
      return { ok: true, path };
    },
  });

  const createWorkspaceFile = defineLocalTool({
    description: "Create a new file in the writable checkout. Fails if path already exists.",
    schema: z.object({
      path: z.string().min(1),
      content: z.string().max(TRIAGE_NEW_FILE_MAX_BYTES),
    }),
    run: async ({ path, content }) => {
      const fullPath = safePath(root, path);
      if (await stat(fullPath).catch(() => null)) throw new Error("Path already exists");
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
      return { ok: true, path };
    },
  });

  const commitFix = defineLocalTool({
    description: "Commit the staged minimal fix for one finding. One call per threadRootCommentId.",
    schema: z.object({
      threadRootCommentId: z.number().int().positive(),
      files: z.array(z.string().min(1)).min(1),
      subject: z.string().min(1),
      body: z.array(z.string().min(1)).optional(),
    }),
    run: async ({ threadRootCommentId, files, subject, body }) => {
      if (!inventoryIds.has(threadRootCommentId)) throw new Error("Unknown threadRootCommentId");
      if (params.state.commitByThreadRootCommentId.has(threadRootCommentId)) {
        throw new Error("commitFix already called for this threadRootCommentId");
      }
      if (params.state.commitByThreadRootCommentId.size >= params.cfg.maxTriageFixesPerRun) {
        throw new Error("Triage fix budget reached");
      }
      const result = await params.checkout.commit({ files, subject, body });
      params.state.commitByThreadRootCommentId.set(threadRootCommentId, result.sha);
      return result;
    },
  });

  const tools = {
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
    editWorkspaceFile,
    createWorkspaceFile,
    commitFix,
  };

  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(tool)]),
    ),
  };
}
