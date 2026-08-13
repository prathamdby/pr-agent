import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { Config } from "../../config.js";
import { AppError, nodeErrorCode, nonErrorThrown } from "../../errors/appError.js";
import { assertContainedWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import {
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
} from "../../settings/index.js";
import { isSensitivePath } from "../ask/askSafety.js";
import { defineLocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import type { AgentRunnerToolExecutorMap } from "../providers/interface.js";
import { readBudgetedWorkspaceTextFile } from "../tools/readWorkspaceTextFile.js";

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

export type VerificationWorkspaceTools = {
  readonly piTools: PiTool[];
  readonly executors: AgentRunnerToolExecutorMap;
};

export function buildVerificationWorkspaceTools(params: {
  readonly cfg: Config;
  readonly rootDir: string;
}): VerificationWorkspaceTools {
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
      const stdout = await git(
        root,
        ["grep", "-nF", "-I", `--max-count=${maxResults + 1}`, "-e", query, "--", "."],
        LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
      ).catch((error) => {
        const err =
          error instanceof Error ? error : nonErrorThrown("verification.git_grep_non_error_thrown");
        if (nodeErrorCode(err) === 1) return "";
        throw err;
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
      "Return the current unified diff for a repo-relative path in the PR repository view.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const fullPath = await safePath(root, path);
      const rel = relativePath(root, fullPath);
      const diff = await git(root, ["diff", "HEAD", "--", rel], LOCAL_WORKSPACE_FETCH_TIMEOUT_MS);
      return { path: rel, diff };
    },
  });

  return {
    piTools: [
      toPiTool("readWorkspaceFile", readWorkspaceFile),
      toPiTool("searchWorkspace", searchWorkspace),
      toPiTool("getWorkspaceDiff", getWorkspaceDiff),
    ],
    executors: {
      readWorkspaceFile: toExecutor("readWorkspaceFile", readWorkspaceFile),
      searchWorkspace: toExecutor("searchWorkspace", searchWorkspace),
      getWorkspaceDiff: toExecutor("getWorkspaceDiff", getWorkspaceDiff),
    },
  };
}
