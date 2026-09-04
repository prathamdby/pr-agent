import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
import { assertContainedWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import {
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
} from "../../settings/index.js";
import { isSensitivePath } from "../ask/askSafety.js";
import { defineLocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import { readBudgetedWorkspaceTextFile } from "../tools/readWorkspaceTextFile.js";
import { isTriageSearchPathAllowed } from "../triage/triageWorkspaceTools.js";
import { normalizeRepoRelativePath } from "../triage/triageWritePolicy.js";

const exec = promisify(execFile);

async function safePath(root: string, path: string): Promise<string> {
  const normalized = path.replace(/\\/g, "/");
  if (isSensitivePath(normalized)) {
    throw new AppError({
      code: "verification.sensitive_path_blocked",
      message: `Blocked sensitive path "${normalized}"`,
      context: { path: normalized },
    });
  }
  return assertContainedWorkspacePath(root, normalized);
}

function relativePath(root: string, fullPath: string): string {
  return relative(root, fullPath).replace(/\\/g, "/");
}

type VerificationSearchMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

function execCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return error.code;
}

function execStdout(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return "";
  return typeof error.stdout === "string" ? error.stdout : "";
}

async function git(
  root: string,
  args: readonly string[],
  timeoutMs: number,
  maxBufferBytes = 20 * 1024 * 1024,
): Promise<{ stdout: string; outputTruncated: boolean }> {
  try {
    const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
      },
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    });
    return { stdout, outputTruncated: false };
  } catch (error) {
    if (execCode(error) === 1) return { stdout: "", outputTruncated: false };
    if (execCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { stdout: execStdout(error), outputTruncated: true };
    }
    throw error;
  }
}

export function buildVerificationWorkspaceTools(params: {
  readonly cfg: Config;
  readonly rootDir: string;
}): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const root = params.rootDir;

  const readWorkspaceFile = defineLocalTool({
    description: "Read a text file from the PR repository view. Path is repo-relative.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
      maxLines: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    }),
    run: async ({ path, startLine, maxLines }) => {
      const fullPath = await safePath(root, path);
      const result = await readBudgetedWorkspaceTextFile(fullPath, {
        maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
        maxResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
        window: { startLine, maxLines },
      });
      if (result.refused) {
        return { path, refused: true, reason: result.reason };
      }
      return { path, ...result };
    },
  });

  const searchWorkspace = defineLocalTool({
    description: "Search the PR repository view with git grep for a literal string.",
    schema: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 20),
    }),
    run: async ({ query, maxResults }) => {
      // No `--max-count`: blocked hits must not consume the result cap.
      const { stdout, outputTruncated } = await git(
        root,
        ["grep", "-nF", "-I", "-e", query, "--", "."],
        LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
        LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
      );
      const lines = stdout.split("\n").filter(Boolean);
      const allowedPathCache = new Map<string, Promise<boolean>>();
      const matches: VerificationSearchMatch[] = [];
      let filteredCount = 0;
      for (const line of lines) {
        const first = line.indexOf(":");
        const second = line.indexOf(":", first + 1);
        if (first < 1 || second < 0) continue;
        const rawPath = line.slice(0, first);
        const normalizedPath = normalizeRepoRelativePath(rawPath);
        let allowed = allowedPathCache.get(normalizedPath);
        if (!allowed) {
          allowed = isTriageSearchPathAllowed(root, normalizedPath);
          allowedPathCache.set(normalizedPath, allowed);
        }
        if (!(await allowed)) {
          filteredCount += 1;
          continue;
        }
        const lineNumber = Number(line.slice(first + 1, second));
        if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
        matches.push({
          path: normalizedPath,
          line: lineNumber,
          text: line.slice(second + 1),
        });
      }
      if (filteredCount > 0) {
        logDebug("verification_search_matches_filtered", {
          filteredCount,
          reason: "sensitive_or_control_path",
        });
      }
      return {
        matches: matches.slice(0, maxResults),
        truncated: outputTruncated || matches.length > maxResults,
        ...(filteredCount > 0 ? { filtered: true } : {}),
      };
    },
  });

  const getWorkspaceDiff = defineLocalTool({
    description:
      "Return the current unified diff for a repo-relative path in the PR repository view.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const fullPath = await safePath(root, path);
      const rel = relativePath(root, fullPath);
      const { stdout: diff } = await git(
        root,
        ["diff", "HEAD", "--", rel],
        LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
      );
      return { path: rel, diff };
    },
  });

  const tools = {
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
  };

  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(name, tool)]),
    ),
  };
}
