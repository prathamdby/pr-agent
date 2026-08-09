import { readFile, stat } from "node:fs/promises";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { CheckoutCoverage, LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
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
import {
  LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
} from "../../settings/index.js";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  type EvidenceLedger,
} from "../../review/findings/evidenceLedger.js";
import { parseCommentableRightLineRanges } from "../../review/placement/reviewDiffIndex.js";

export type LocalWorkspaceToolLimits = {
  readonly maxFileBytes: number;
  readonly readResponseBytes: number;
  readonly diffResponseBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxTotalBytes: number;
};

const DEFAULT_LOCAL_WORKSPACE_TOOL_LIMITS: LocalWorkspaceToolLimits = {
  maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
  readResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  diffResponseBytes: LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES,
  searchMaxFiles: LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  searchMaxTotalBytes: LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
};

const BINARY_SAMPLE_BYTES = 8192;

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

function coverageWarning(coverage: CheckoutCoverage): string | undefined {
  const parts: string[] = [];
  if (coverage.mode === "sparse") {
    parts.push("sparse checkout — search and reads only see paths on disk");
  }
  if (coverage.changeSetTruncated) {
    parts.push("change set truncated");
  }
  if (coverage.searchTruncated) {
    parts.push("search truncated");
  }
  if (coverage.warning) {
    parts.push(coverage.warning);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function changedFileForPath(workspace: LocalPrWorkspace, path: string) {
  return workspace.changedFileByPath.get(normalizeEvidencePath(path));
}

function recordFileReadEvidence(
  ledger: EvidenceLedger,
  params: {
    readonly path: string;
    readonly headSha: string;
    readonly tool: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  },
): void {
  ledger.record({
    path: params.path,
    startLine: params.startLine,
    endLine: params.endLine,
    contentHash: hashNormalizedLineText(params.content),
    headSha: params.headSha,
    tool: params.tool,
  });
}

function recordDiffEvidence(
  ledger: EvidenceLedger,
  params: {
    readonly path: string;
    readonly headSha: string;
    readonly tool: string;
    readonly diff: string;
  },
): void {
  const contentHash = hashNormalizedLineText(params.diff);
  for (const [startLine, endLine] of parseCommentableRightLineRanges(params.diff)) {
    ledger.record({
      path: params.path,
      startLine,
      endLine,
      contentHash,
      headSha: params.headSha,
      tool: params.tool,
    });
  }
}

async function refuseUnlessReadableFile(
  workspace: LocalPrWorkspace,
  normalized: string,
  limits: LocalWorkspaceToolLimits,
): Promise<{ refused: true; reason: string; coverage: CheckoutCoverage } | null> {
  if (!workspace.isPathInCheckout(normalized)) {
    return {
      refused: true,
      reason: "Path is missing from the checkout.",
      coverage: workspace.getCoverage(),
    };
  }
  const safePath = assertWorkspacePath(workspace.agentCwd, normalized);
  const info = await stat(safePath).catch(() => null);
  if (!info?.isFile()) {
    return {
      refused: true,
      reason: "Path is missing from the checkout.",
      coverage: workspace.getCoverage(),
    };
  }
  if (info.size > limits.maxFileBytes) {
    return {
      refused: true,
      reason: `File exceeds ${limits.maxFileBytes} byte read limit.`,
      coverage: workspace.getCoverage(),
    };
  }
  return null;
}

export function buildLocalWorkspaceTools(
  workspace: LocalPrWorkspace,
  opts?: {
    readonly limits?: LocalWorkspaceToolLimits;
    readonly pathGate?: AskPathGate;
    readonly extraAllowedPaths?: readonly string[];
    readonly evidenceLedger?: EvidenceLedger;
    readonly headSha?: string;
  },
): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const limits = opts?.limits ?? DEFAULT_LOCAL_WORKSPACE_TOOL_LIMITS;
  const pathGate = opts?.pathGate ?? createAskPathGate();
  const evidenceLedger = opts?.evidenceLedger;
  const headSha = opts?.headSha ?? evidenceLedger?.headSha;
  primePathGate(workspace, pathGate, opts?.extraAllowedPaths);

  const listChangedFiles: LocalTool = {
    description:
      "Start here: list files changed in this pull request (path, status, presence in the PR head checkout).",
    schema: v.object({}),
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
      "Read a text file from the PR head checkout (paths relative to repo root). Use startLine/maxLines on long files to trace callers, types, and config beyond the diff. Responses are byte-capped; on truncated, narrow the range — do not retry the same call unchanged.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
      maxLines: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    }),
    run: async ({ path, startLine, maxLines }) => {
      const normalized = normalizeEvidencePath(path);
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
      if (buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)).includes(0)) {
        return {
          path: normalized,
          refused: true,
          reason: "Binary file cannot be read as text.",
        };
      }
      const text = buf.toString("utf8");
      const readOutput = readTextWithOutputBudget(text, limits.readResponseBytes, {
        startLine,
        maxLines,
      });
      if (evidenceLedger && headSha && readOutput.startLine > 0 && readOutput.endLine > 0) {
        recordFileReadEvidence(evidenceLedger, {
          path: normalized,
          headSha,
          tool: "readWorkspaceFile",
          startLine: readOutput.startLine,
          endLine: readOutput.endLine,
          content: readOutput.content,
        });
      }
      return {
        path: normalized,
        ...readOutput,
      };
    },
  };

  const searchWorkspace: LocalTool = {
    description:
      "Search the full PR head checkout with git grep for a literal string (not a regex). Use to find callers, types, and config beyond the diff. Skips binary files. On truncated, narrow the query — do not retry unchanged. pathsSearched is how many checkout paths were scanned; filesScanned is the distinct matched file count.",
    schema: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 20),
    }),
    run: async ({ query, maxResults }) => {
      const allowedPaths = workspace.sortedCheckoutPaths.filter((path) =>
        pathAllowedForAsk(path, pathGate),
      );
      const pathsSearched = allowedPaths.length;
      if (allowedPaths.length === 0) {
        return { matches: [], truncated: false, pathsSearched: 0, filesScanned: 0 };
      }
      const result = await workspace.grepLiteral({
        query,
        maxResults,
        maxOutputBytes: limits.searchMaxTotalBytes,
        paths: allowedPaths,
      });
      const truncated = result.truncated || result.matches.length > maxResults;
      if (truncated) {
        workspace.noteSearchTruncated();
      }
      const matchedFiles = new Set(result.matches.map((match) => match.path));
      const coverage = workspace.getCoverage();
      const warning = truncated ? coverageWarning(coverage) : undefined;
      return {
        matches: result.matches.slice(0, maxResults),
        truncated,
        pathsSearched,
        filesScanned: matchedFiles.size,
        ...(truncated ? { coverage, ...(warning ? { warning } : {}) } : {}),
      };
    },
  };

  const getWorkspaceDiff: LocalTool = {
    description:
      "After listChangedFiles, read each change's PR unified diff before opening whole files. Path from the changed-file list. Responses are byte-capped; on truncated, narrow the path or follow up with a focused file read.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const normalized = normalizeEvidencePath(path);
      assertPathAllowedForAsk(normalized, pathGate);
      const diff = await workspace.getDiffForPath(normalized);
      const capped = capTextOutput(diff, limits.diffResponseBytes, "response byte budget exceeded");
      if (evidenceLedger && headSha && capped.content.length > 0) {
        recordDiffEvidence(evidenceLedger, {
          path: normalized,
          headSha,
          tool: "getWorkspaceDiff",
          diff: capped.content,
        });
      }
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
      "Best-effort local git blame at PR head. Use only when authorship genuinely decides a finding. Responses are byte-capped; prefer startLine/maxLines on readWorkspaceFile for focused follow-up context.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
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

  const resolveSymbol: LocalTool = {
    description:
      "Look up symbol definitions in the ephemeral per-run symbol index (TypeScript/JavaScript/Python heuristics). Navigation hint only — you must call readWorkspaceFile on any match before citing path or line numbers in findings.",
    schema: v.object({
      name: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(
        v.pipe(v.number(), v.integer(), v.gtValue(0)),
        LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
      ),
    }),
    run: async ({ name, maxResults }) => {
      const status = workspace.getSymbolIndexStatus();
      const matches = workspace.lookupSymbol(name, maxResults);
      return {
        name,
        available: status.available,
        matches,
        ...(status.available ? {} : { reason: "Symbol index unavailable for this workspace." }),
        reminder: "Call readWorkspaceFile before citing any match.",
      };
    },
  };

  const tools: Record<string, LocalTool> = {
    listChangedFiles,
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
    getWorkspaceBlame,
    resolveSymbol,
  };
  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(tool)]),
    ),
  };
}
