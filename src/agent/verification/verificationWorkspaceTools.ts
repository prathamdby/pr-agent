import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logDebug } from "../../evlog.js";
import {
  assertContainedWorkspacePath,
  assertWorkspacePath,
  type LocalPrWorkspace,
} from "../../prWorkspace/localPrWorkspace.js";
import {
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
} from "../../settings/index.js";
import { isSensitivePath } from "../ask/askSafety.js";
import { defineLocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import { readBudgetedWorkspaceTextFile } from "../tools/readWorkspaceTextFile.js";
import { isTriageSearchPathAllowed } from "../triage/triageWorkspaceTools.js";
import { normalizeRepoRelativePath } from "../triage/triageWritePolicy.js";

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

type VerificationSearchMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

function assertDiffPath(root: string, path: string): string {
  const normalized = normalizeRepoRelativePath(path);
  if (isSensitivePath(normalized)) {
    throw new AppError({
      code: "verification.sensitive_path_blocked",
      message: `Blocked sensitive path "${normalized}"`,
      context: { path: normalized },
    });
  }
  assertWorkspacePath(root, normalized);
  return normalized;
}

export function buildVerificationWorkspaceTools(params: {
  readonly cfg: Config;
  readonly workspace: LocalPrWorkspace;
}): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const workspace = params.workspace;
  const root = workspace.agentCwd;

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
      const allowedPaths: string[] = [];
      let filteredCount = 0;
      for (const path of workspace.sortedCheckoutPaths) {
        if (await isTriageSearchPathAllowed(root, path)) {
          allowedPaths.push(path);
        } else {
          filteredCount += 1;
        }
      }
      const fullCoverage = allowedPaths.length === workspace.sortedCheckoutPaths.length;
      const result =
        allowedPaths.length === 0
          ? { matches: [], truncated: false }
          : fullCoverage
            ? await workspace.grepLiteral({
                query,
                maxResults,
                maxOutputBytes: LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
              })
            : await workspace.grepLiteral({
                query,
                maxResults,
                maxOutputBytes: LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
                paths: allowedPaths,
              });
      const matches: VerificationSearchMatch[] = result.matches.map((match) => ({
        path: normalizeRepoRelativePath(match.path),
        line: match.line,
        text: match.text,
      }));
      if (filteredCount > 0) {
        logDebug("verification_search_matches_filtered", {
          filteredCount,
          reason: "sensitive_or_control_path",
        });
      }
      return {
        matches: matches.slice(0, maxResults),
        truncated: result.truncated || matches.length > maxResults,
        ...(filteredCount > 0 ? { filtered: true } : {}),
      };
    },
  });

  const getWorkspaceDiff = defineLocalTool({
    description: "Return the cached GitHub PR unified diff for a repo-relative path.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const rel = assertDiffPath(root, path);
      const diff = await workspace.getDiffForPath(rel);
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
