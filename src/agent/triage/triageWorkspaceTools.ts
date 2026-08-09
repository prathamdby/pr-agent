import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import { assertContainedWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import {
  TRIAGE_COMMIT_BODY_MAX_BULLETS,
  TRIAGE_NEW_FILE_MAX_BYTES,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  MAX_TRIAGE_FIXES_PER_RUN,
} from "../../settings/index.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { defineLocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import {
  assertTriageStagePaths,
  assertTriageWritablePath,
  isTriageControlPath,
  normalizeRepoRelativePath,
} from "./triageWritePolicy.js";

const exec = promisify(execFile);

export type TriageWorkspaceToolState = {
  readonly commitByThreadRootCommentId: Map<number, string>;
};

async function safeReadPath(root: string, path: string): Promise<string> {
  const normalized = normalizeRepoRelativePath(path);
  if (isTriageControlPath(normalized)) {
    throw new AppError({
      code: "triage.sensitive_path_blocked",
      message: `Blocked sensitive path "${normalized}"`,
      context: { path: normalized },
    });
  }
  return assertContainedWorkspacePath(root, normalized);
}

function relativePath(root: string, fullPath: string): string {
  return relative(root, fullPath).replace(/\\/g, "/");
}

async function readTextFile(root: string, path: string, maxBytes: number) {
  const fullPath = await safeReadPath(root, path);
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
  const implicatedPaths = new Set(
    params.inventory.map((thread) => normalizeRepoRelativePath(thread.path)),
  );
  const root = params.checkout.dir;

  const readWorkspaceFile = defineLocalTool({
    description: "Read a text file from the writable PR checkout. Path is repo-relative.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => readTextFile(root, path, LOCAL_WORKSPACE_MAX_FILE_BYTES),
  });

  const searchWorkspace = defineLocalTool({
    description: "Search the writable checkout with git grep for a literal string.",
    schema: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 20),
    }),
    run: async ({ query, maxResults }) => {
      // Avoid `git grep --max-count` (requires git ≥2.40); cap results after the fact.
      const stdout = await git(
        root,
        ["grep", "-nF", "-I", "-e", query, "--", "."],
        LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
      ).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
          return "";
        }
        throw error;
      });
      const lines = stdout.split("\n").filter(Boolean);
      const matches = lines.slice(0, maxResults).map((line) => {
        const first = line.indexOf(":");
        const second = line.indexOf(":", first + 1);
        return {
          path: line.slice(0, first),
          line: Number(line.slice(first + 1, second)),
          text: line.slice(second + 1),
        };
      });
      return { matches, truncated: lines.length > maxResults };
    },
  });

  const getWorkspaceDiff = defineLocalTool({
    description:
      "Return the current unified diff for a repo-relative path in the writable checkout.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const fullPath = await safeReadPath(root, path);
      const rel = relativePath(root, fullPath);
      const diff = await git(root, ["diff", "HEAD", "--", rel], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
      return { path: rel, diff };
    },
  });

  const editWorkspaceFile = defineLocalTool({
    description:
      "Exact-match replacement in a writable checkout file. oldText must match exactly once.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      oldText: v.pipe(v.string(), v.minLength(1)),
      newText: v.string(),
    }),
    run: async ({ path, oldText, newText }) => {
      const { fullPath, relativePath: rel } = await assertTriageWritablePath({
        root,
        path,
        mode: "edit",
        implicatedPaths,
      });
      const content = await readFile(fullPath, "utf8");
      const matches = countOccurrences(content, oldText);
      if (matches === 0) {
        throw new AppError({
          code: "triage.old_text_not_found",
          message: "oldText not found; re-read the file",
          context: { path: rel },
        });
      }
      if (matches > 1) {
        throw new AppError({
          code: "triage.old_text_ambiguous",
          message: "oldText is ambiguous; include more surrounding context",
          context: { path: rel },
        });
      }
      await writeFile(fullPath, content.replace(oldText, newText));
      return { ok: true, path: rel };
    },
  });

  const createWorkspaceFile = defineLocalTool({
    description: "Create a new file in the writable checkout. Fails if path already exists.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      content: v.pipe(v.string(), v.maxLength(TRIAGE_NEW_FILE_MAX_BYTES)),
    }),
    run: async ({ path, content }) => {
      const { fullPath, relativePath: rel } = await assertTriageWritablePath({
        root,
        path,
        mode: "create",
        implicatedPaths,
      });
      if (await stat(fullPath).catch(() => null)) {
        throw new AppError({
          code: "triage.path_exists",
          message: "Path already exists",
          context: { path: rel },
        });
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
      return { ok: true, path: rel };
    },
  });

  const commitFix = defineLocalTool({
    description: "Commit the minimal fix for one finding. One call per threadRootCommentId.",
    schema: v.object({
      threadRootCommentId: v.pipe(v.number(), v.integer(), v.gtValue(0)),
      files: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
      subject: v.pipe(v.string(), v.minLength(1)),
      body: v.optional(
        v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1))),
          v.maxLength(TRIAGE_COMMIT_BODY_MAX_BULLETS),
        ),
      ),
    }),
    run: async ({ threadRootCommentId, files, subject, body }) => {
      if (!inventoryIds.has(threadRootCommentId)) {
        throw new AppError({
          code: "triage.unknown_thread",
          message: "Unknown threadRootCommentId",
          context: { threadRootCommentId },
        });
      }
      if (params.state.commitByThreadRootCommentId.has(threadRootCommentId)) {
        throw new AppError({
          code: "triage.commit_fix_duplicate",
          message: "commitFix already called for this threadRootCommentId",
          context: { threadRootCommentId },
        });
      }
      if (params.state.commitByThreadRootCommentId.size >= MAX_TRIAGE_FIXES_PER_RUN) {
        throw new AppError({
          code: "triage.fix_budget_reached",
          message: "Triage fix budget reached",
        });
      }
      const staged = await assertTriageStagePaths({
        root,
        files,
        implicatedPaths,
      });
      const result = await params.checkout.commit({ files: [...staged], subject, body });
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
