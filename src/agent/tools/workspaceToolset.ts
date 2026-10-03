import { logDebug } from "../../evlog.js";
import {
  createPathPolicy,
  assertContainedWorkspacePath,
  type CheckoutCoverage,
  type GitGrepWorkspaceResult,
  type PathPolicy,
  type PinnedRepositoryReader,
  type RepositoryReader,
} from "../../prWorkspace/repositoryReader.js";
import { normalizeRepoRelativePath } from "../triage/triageWritePolicy.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import {
  createAskPathGate,
  redactPorcelainBlame,
  sanitizeToolResultForAsk,
  type AskPathGate,
} from "../ask/askSafety.js";
import { defineLocalTool, type LocalTool, toExecutor, toPiTool } from "./defineWorkspaceTool.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import {
  MISSING_FROM_CHECKOUT_REASON,
  disposeSpillFile,
  type BudgetedWorkspaceTextFileRead,
  type SpilledWorkspaceTextFileRead,
  type TextSpillScope,
} from "./readWorkspaceTextFile.js";
import { capTextOutput } from "./toolOutputBudget.js";
import {
  LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY,
  LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
} from "../../settings/index.js";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  recordDeliveredFileRead,
  type EvidenceLedger,
  type EvidenceDescriptor,
  type DeliveredFileRead,
} from "../../review/findings/evidenceLedger.js";
import { AppError } from "../../errors/appError.js";
import { MAX_TOOL_ROUNDS } from "../../settings/index.js";
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

/** Recovery reads use the investigation path policy and ordinary file/output clamps. */
export function createGovernedReviewEvidenceReader(
  workspace: PinnedRepositoryReader,
  headSha: string,
) {
  const gate = createAskPathGate();
  primePathGate(workspace, gate);
  const policy = createPathPolicy(workspace.agentCwd, { kind: "investigation", gate });
  let remainingReads = MAX_TOOL_ROUNDS;
  let remainingBytes = LOCAL_WORKSPACE_READ_RESPONSE_BYTES * MAX_TOOL_ROUNDS;
  return async (descriptor: EvidenceDescriptor): Promise<DeliveredFileRead | null> => {
    if (
      remainingReads <= 0 ||
      remainingBytes <= 0 ||
      descriptor.headSha !== headSha ||
      !policy.allows(descriptor.path) ||
      !workspace.isPathInCheckout(descriptor.path)
    )
      return null;
    remainingReads -= 1;
    try {
      // A freshly reintroduced symlink must not exploit the stripped-checkout assumption.
      await assertContainedWorkspacePath(workspace.agentCwd, descriptor.path);
      const result = await workspace.readFile(descriptor.path, policy, {
        maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
        maxResponseBytes: Math.min(LOCAL_WORKSPACE_READ_RESPONSE_BYTES, remainingBytes),
        window: {
          startLine: descriptor.startLine,
          maxLines: descriptor.endLine - descriptor.startLine + 1,
        },
      });
      if (result.refused || result.truncated) return null;
      remainingBytes -= Buffer.byteLength(result.content, "utf8");
      return {
        path: descriptor.path,
        headSha,
        tool: "readWorkspaceFile",
        content: result.content,
        startLine: result.startLine,
        endLine: result.endLine,
        clampedLines: result.clampedLines,
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "pr_workspace.symlink_escape" ||
          error.code === "pr_workspace.path_traversal")
      )
        return null;
      throw error;
    }
  };
}

function primePathGate(
  workspace: PinnedRepositoryReader,
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

function changedFileForPath(workspace: PinnedRepositoryReader, path: string) {
  return workspace.changedFileByPath.get(normalizeEvidencePath(path));
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

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sameDirEntries(
  normalized: string,
  checkoutPaths: readonly string[],
): { readonly filename: string; readonly entries: string[] } {
  const slash = normalized.lastIndexOf("/");
  const dir = slash === -1 ? "" : normalized.slice(0, slash + 1);
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1);
  const entries = checkoutPaths.filter((entry) => {
    if (!entry.startsWith(dir)) return false;
    const rest = entry.slice(dir.length);
    return rest.length > 0 && !rest.includes("/");
  });
  return { filename, entries };
}

function canonicalizeFilename(name: string): string {
  // NFC collapses composed/decomposed accents; the space/quote pairs below
  // render identically in a terminal (macOS screenshot names, Finder renames).
  return name
    .normalize("NFC")
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/[\u2019\u2018]/g, "'");
}

function findUnicodeEquivalentPath(
  normalized: string,
  checkoutPaths: readonly string[],
): string | undefined {
  const { filename, entries } = sameDirEntries(normalized, checkoutPaths);
  if (filename.length === 0) return undefined;
  const target = canonicalizeFilename(filename);
  const matches = entries.filter(
    (entry) => entry !== normalized && canonicalizeFilename(basenameOf(entry)) === target,
  );
  // Exactly one equivalent spelling is an unambiguous repair. Zero or several
  // falls through to suggestions; guessing among homoglyph collisions would
  // silently read the wrong file.
  return matches.length === 1 ? matches[0] : undefined;
}

function bigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bigram = a.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const bigram = b.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      common += 1;
      bigrams.set(bigram, count - 1);
    }
  }
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

function suggestSimilarPaths(
  normalized: string,
  checkoutPaths: readonly string[],
  policy: PathPolicy,
): string[] {
  const { filename, entries } = sameDirEntries(normalized, checkoutPaths);
  const target = filename.toLowerCase();
  if (target.length === 0) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const entry of entries) {
    if (entry === normalized) continue;
    const score = bigramDiceSimilarity(target, basenameOf(entry).toLowerCase());
    if (score >= LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY && policy.allows(entry)) {
      scored.push({ path: entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS).map((entry) => entry.path);
}

function buildInvestigationTools(
  workspace: PinnedRepositoryReader,
  opts?: {
    readonly limits?: LocalWorkspaceToolLimits;
    readonly pathGate?: AskPathGate;
    readonly extraAllowedPaths?: readonly string[];
    readonly evidenceLedger?: EvidenceLedger;
    readonly headSha?: string;
    readonly spillScope?: TextSpillScope;
  },
): {
  piTools: PiTool[];
  executors: Record<string, AgentRunnerToolExecutor>;
  disposeSpillFiles: () => Promise<readonly string[]>;
} {
  const limits = opts?.limits ?? DEFAULT_LOCAL_WORKSPACE_TOOL_LIMITS;
  const pathGate = opts?.pathGate ?? createAskPathGate();
  const evidenceLedger = opts?.evidenceLedger;
  const headSha = opts?.headSha ?? evidenceLedger?.headSha;
  const spillPaths: string[] = [];
  const policy = createPathPolicy(workspace.agentCwd, { kind: "investigation", gate: pathGate });
  primePathGate(workspace, pathGate, opts?.extraAllowedPaths);

  const listChangedFiles = defineLocalTool({
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
  });

  const readWorkspaceFile = defineLocalTool({
    description:
      "Read a text file from the PR head checkout (paths relative to repo root). Use startLine/maxLines on long files to trace callers, types, and config beyond the diff. Responses are byte-capped; oversized reads spill to a session file and return a tail with `spilled: true` — the spill file is not read evidence, so re-read the source path with explicit startLine/maxLines before citing any line. On truncated, narrow the range — do not retry the same call unchanged. Missing paths explain why and may include similarPaths; empty files and past-EOF windows return a note — act on it instead of retrying.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
      maxLines: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    }),
    run: async ({ path, startLine, maxLines }) => {
      const normalized = normalizeEvidencePath(path);
      policy.assertDiff(normalized);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, content: null };
      }

      const respondWithRead = (
        readPath: string,
        result: BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead,
        note?: string,
      ) => {
        if (result.refused) {
          return {
            path: readPath,
            refused: true,
            reason: result.reason,
            coverage: workspace.getCoverage(),
            ...(note ? { note } : {}),
          };
        }
        if ("spilled" in result && result.spilled) {
          spillPaths.push(result.spillPath);
          const combinedNote = [note, result.note].filter(Boolean).join(" ");
          const { path: _ignored, note: _noteIgnored, ...spill } = result;
          return {
            path: readPath,
            ...spill,
            ...(combinedNote ? { note: combinedNote } : {}),
          };
        }
        if (
          !("spilled" in result) &&
          evidenceLedger &&
          headSha &&
          result.content.length > 0 &&
          result.startLine > 0 &&
          result.endLine > 0
        ) {
          recordDeliveredFileRead(evidenceLedger, {
            path: readPath,
            headSha,
            tool: "readWorkspaceFile",
            startLine: result.startLine,
            endLine: result.endLine,
            content: result.content,
            clampedLines: result.clampedLines,
          });
        }
        const combinedNote = [note, result.note].filter(Boolean).join(" ");
        return {
          path: readPath,
          ...result,
          ...(combinedNote ? { note: combinedNote } : {}),
        };
      };

      // Invisible unicode differences (NFC/NFD, narrow no-break space, curly
      // quotes) make a visually-correct path not-found forever; the byte
      // mismatch doesn't render, so no amount of model reasoning recovers.
      // Repairing is the tool's job — but only on a single unambiguous match.
      const respondToMissing = async () => {
        const resolved = findUnicodeEquivalentPath(normalized, workspace.sortedCheckoutPaths);
        if (resolved !== undefined && policy.allows(resolved)) {
          const repairNote = `requested '${normalized}' not found byte-for-byte; resolved to unicode-equivalent '${resolved}'`;
          const resolvedResult = await workspace.readFile(resolved, policy, {
            maxFileBytes: limits.maxFileBytes,
            maxResponseBytes: limits.readResponseBytes,
            window: { startLine, maxLines },
            ...(opts?.spillScope != null ? { spillScope: opts.spillScope } : {}),
          });
          return respondWithRead(resolved, resolvedResult, repairNote);
        }
        const similarPaths = suggestSimilarPaths(normalized, workspace.sortedCheckoutPaths, policy);
        return {
          path: normalized,
          refused: true,
          reason: MISSING_FROM_CHECKOUT_REASON,
          coverage: workspace.getCoverage(),
          ...(similarPaths.length > 0 ? { similarPaths } : {}),
        };
      };

      if (!workspace.isPathInCheckout(normalized)) {
        return respondToMissing();
      }
      const result = await workspace.readFile(normalized, policy, {
        maxFileBytes: limits.maxFileBytes,
        maxResponseBytes: limits.readResponseBytes,
        window: { startLine, maxLines },
        ...(opts?.spillScope != null ? { spillScope: opts.spillScope } : {}),
      });
      if (result.refused && result.refusalKind === "missing") {
        return respondToMissing();
      }
      return respondWithRead(normalized, result);
    },
  });

  const searchWorkspace = defineLocalTool({
    description:
      "Search the full PR head checkout with git grep for a literal string (not a regex). Use to find callers, types, and config beyond the diff. Skips binary files. On truncated, narrow the query — do not retry unchanged. pathsSearched is how many checkout paths were scanned; filesScanned is the distinct matched file count.",
    schema: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 20),
    }),
    run: async ({ query, maxResults }) => {
      const allowedPaths = workspace.sortedCheckoutPaths.filter((path) => policy.allows(path));
      const pathsSearched = allowedPaths.length;
      if (allowedPaths.length === 0) {
        return { matches: [], truncated: false, pathsSearched: 0, filesScanned: 0 };
      }
      // Full-tree coverage searches the same on-disk tree either way
      // (symlinks are stripped at checkout, `.git` lives outside the
      // worktree), so use the single-shot scan instead of one git grep
      // process per 256-pathspec chunk.
      const fullCoverage = allowedPaths.length === workspace.sortedCheckoutPaths.length;
      const result = fullCoverage
        ? await workspace.grepLiteral({
            query,
            maxResults,
            maxOutputBytes: limits.searchMaxTotalBytes,
          })
        : await workspace.grepLiteral({
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
  });

  const getWorkspaceDiff = defineLocalTool({
    description:
      "After listChangedFiles, read each change's PR unified diff before opening whole files. Path from the changed-file list. Responses are byte-capped; on truncated, narrow the path or follow up with a focused file read.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const normalized = normalizeEvidencePath(path);
      policy.assertDiff(normalized);
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
  });

  const getWorkspaceBlame = defineLocalTool({
    description:
      "Best-effort local git blame at PR head. Use only when authorship genuinely decides a finding. Responses are byte-capped; prefer startLine/maxLines on readWorkspaceFile for focused follow-up context.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const normalized = path.replace(/\\/g, "/");
      policy.assertDiff(normalized);
      const changed = changedFileForPath(workspace, normalized);
      if (changed?.status === "deleted") {
        return { path: normalized, deleted: true, blame: null };
      }
      if (!workspace.isPathInCheckout(normalized)) {
        return {
          path: normalized,
          refused: true,
          reason: MISSING_FROM_CHECKOUT_REASON,
          coverage: workspace.getCoverage(),
          blame: null,
        };
      }
      const refusal = await workspace.refuseFile(normalized, policy, limits.maxFileBytes);
      if (refusal) {
        return {
          path: normalized,
          refused: true,
          reason: refusal.reason,
          coverage: workspace.getCoverage(),
          blame: null,
        };
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
  });

  const resolveSymbol = defineLocalTool({
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
  });

  const tools: Record<string, LocalTool> = {
    listChangedFiles,
    readWorkspaceFile,
    searchWorkspace,
    getWorkspaceDiff,
    getWorkspaceBlame,
    resolveSymbol,
  };
  return {
    ...defineToolset(tools),
    disposeSpillFiles: async () => {
      const paths = spillPaths.splice(0, spillPaths.length);
      const outcomes = await Promise.allSettled(
        paths.map((spillPath) => disposeSpillFile(spillPath)),
      );
      return paths.filter((_, index) => outcomes[index]?.status === "rejected");
    },
  };
}

const workspaceExecutionModes = new Map<string, "sequential">();
export function workspaceToolExecutionMode(name: string): "sequential" | undefined {
  return workspaceExecutionModes.get(name);
}

export function defineToolset(tools: Record<string, LocalTool>, mode?: "sequential") {
  if (mode) for (const name of Object.keys(tools)) workspaceExecutionModes.set(name, mode);
  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(name, tool)]),
    ),
  };
}

function buildVerificationTools(workspace: PinnedRepositoryReader) {
  const root = workspace.agentCwd;
  const policy = createPathPolicy(root, { kind: "verification" });
  const readWorkspaceFile = defineLocalTool({
    description: "Read a text file from the PR repository view. Path is repo-relative.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
      maxLines: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    }),
    run: async ({ path, startLine, maxLines }) => {
      const result = await workspace.readFile(path, policy, {
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
        if (await policy.allowsSearch(path)) {
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
      const matches: GitGrepWorkspaceResult["matches"] = result.matches.map((match) => ({
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
      const rel = policy.assertDiff(path);
      const diff = await workspace.getDiffForPath(rel);
      return { path: rel, diff };
    },
  });

  return defineToolset({ readWorkspaceFile, searchWorkspace, getWorkspaceDiff });
}

function buildTriageReadTools(workspace: RepositoryReader) {
  const root = workspace.agentCwd;
  const policy = createPathPolicy(root, { kind: "triage" });
  const readWorkspaceFile = defineLocalTool({
    description: "Read a text file from the writable PR checkout. Path is repo-relative.",
    schema: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
      maxLines: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    }),
    run: async ({ path, startLine, maxLines }) => {
      const result = await workspace.readFile(path, policy, {
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
    description: "Search the writable checkout with git grep for a literal string.",
    schema: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      maxResults: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 20),
    }),
    run: async ({ query, maxResults }) => {
      const result = await workspace.grepLiteral({
        query,
        maxResults: Number.MAX_SAFE_INTEGER,
        maxOutputBytes: LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
      });
      const allowedPathCache = new Map<string, Promise<boolean>>();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let filteredCount = 0;
      for (const match of result.matches) {
        const rawPath = match.path;
        const normalizedPath = normalizeRepoRelativePath(rawPath);
        let allowed = allowedPathCache.get(normalizedPath);
        if (!allowed) {
          allowed = policy.allowsSearch(normalizedPath);
          allowedPathCache.set(normalizedPath, allowed);
        }
        if (!(await allowed)) {
          filteredCount += 1;
          continue;
        }
        const lineNumber = match.line;
        if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
        matches.push({
          path: normalizedPath,
          line: lineNumber,
          text: match.text,
        });
      }
      if (filteredCount > 0) {
        logDebug("triage_search_matches_filtered", {
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
    description:
      "Return the current unified diff for a repo-relative path in the writable checkout.",
    schema: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
    run: async ({ path }) => {
      const rel = policy.assertDiff(path);
      const diff = await workspace.getDiffForPath(rel);
      return { path: rel, diff };
    },
  });

  return defineToolset({ readWorkspaceFile, searchWorkspace, getWorkspaceDiff });
}

export function buildWorkspaceTools(
  workspace: PinnedRepositoryReader,
  opts?: Parameters<typeof buildInvestigationTools>[1],
): ReturnType<typeof buildInvestigationTools>;
export function buildWorkspaceTools(
  params:
    | { readonly profile: "verification"; readonly reader: PinnedRepositoryReader }
    | { readonly profile: "triage"; readonly reader: RepositoryReader },
): ReturnType<typeof defineToolset>;
export function buildWorkspaceTools(
  workspace:
    | PinnedRepositoryReader
    | { readonly profile: "verification"; readonly reader: PinnedRepositoryReader }
    | { readonly profile: "triage"; readonly reader: RepositoryReader },
  opts?: Parameters<typeof buildInvestigationTools>[1],
) {
  if ("profile" in workspace)
    return workspace.profile === "verification"
      ? buildVerificationTools(workspace.reader)
      : buildTriageReadTools(workspace.reader);
  return buildInvestigationTools(workspace, opts);
}
