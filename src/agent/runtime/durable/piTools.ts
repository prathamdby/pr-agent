import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { logDebug } from "../../../evlog.ts";
import { createPathPolicy } from "../../tools/pathPolicy.ts";
import {
  assertContainedWorkspacePath,
  type CheckoutCoverage,
  type GitGrepWorkspaceResult,
  type PathPolicy,
  type PinnedRepositoryReader,
  type RepositoryReader,
  type WorkspacePathDiff,
} from "../../../prWorkspace/repositoryReader.ts";
import { normalizeRepoRelativePath } from "../../triage/triageWritePolicy.ts";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import {
  createAskPathGate,
  redactPorcelainBlame,
  sanitizeToolResultForAsk,
  type AskPathGate,
} from "../../ask/askSafety.ts";
import { pageChangedFiles } from "../../tools/changedFilePage.ts";
import {
  defineLocalTool,
  type LocalTool,
  toExecutor,
  toPiTool,
} from "../../tools/defineWorkspaceTool.ts";
import type { AgentRunnerToolExecutor, AgentToolCallContext } from "../../providers/interface.ts";
import {
  MISSING_FROM_CHECKOUT_REASON,
  disposeSpillFile,
  type BudgetedWorkspaceTextFileRead,
  type SpilledWorkspaceTextFileRead,
  type TextSpillScope,
} from "../../tools/readWorkspaceTextFile.ts";
import { capTextOutput, completePrefixLength } from "../../tools/toolOutputBudget.ts";
import {
  literalQueryParam,
  maxLinesParam,
  maxResultsParam,
  repoPathParam,
  startLineParam,
} from "../../tools/toolParams.ts";
import {
  LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES,
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY,
  LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  LOCAL_WORKSPACE_SEARCH_MAX_TERMS,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  LOCAL_WORKSPACE_SEARCH_MAX_MATCHES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
} from "../../../settings/index.ts";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  type EvidenceLedger,
  type EvidenceDescriptor,
  type DeliveredFileRead,
} from "../../../review/findings/evidenceLedger.ts";
import type { OpenReviewThread } from "../../../review/findingIdentity/findingInventory.ts";
import { neutralizeMarkerEcho } from "../../../review/findingIdentity/findingMarker.ts";
import {
  neutralizeEvidenceDelimiters,
  neutralizeForgedTrustHeaders,
} from "../../../prompts/shared/safety.ts";
import { AppError } from "../../../errors/appError.ts";
import { GOVERNED_EVIDENCE_MAX_READS } from "../../../settings/index.ts";
import {
  diffRightLines,
  parseCommentableRightLineRanges,
} from "../../../prWorkspace/reviewDiffIndex.ts";
import { isSensitivePath } from "../../ask/askSafety.ts";
import { includesEvidenceRead, sessionStateFor, type EvidenceReadAttempt } from "./sessionState.ts";
import type { DurableToolMeta } from "./session.ts";

export type LocalWorkspaceToolLimits = {
  readonly maxFileBytes: number;
  readonly readResponseBytes: number;
  readonly diffResponseBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxTotalBytes: number;
};

const REVIEW_THREAD_LIMIT = 5;
const REVIEW_THREAD_FIELD_MAX_BYTES = 8_000;
const REVIEW_THREAD_TITLE_CAP = 200;

export type ReviewThreadSource = () => readonly OpenReviewThread[];

type ReviewThreadFieldEntry = {
  readonly findingId: string;
  readonly severity: string;
  readonly lens: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly title?: string;
  readonly detail?: string;
};

function reviewThreadGap(
  window: { readonly start: number; readonly end: number },
  thread: OpenReviewThread,
) {
  if (thread.startLine == null || thread.endLine == null)
    return ((pinnedReturn: number) => pinnedReturn)(Number.MAX_SAFE_INTEGER);
  const start = Math.min(thread.startLine, thread.endLine);
  const end = Math.max(thread.startLine, thread.endLine);
  if (window.end < start) return ((pinnedReturn: number) => pinnedReturn)(start - window.end);
  if (end < window.start) return ((pinnedReturn: number) => pinnedReturn)(window.start - end);
  return ((pinnedReturn: number) => pinnedReturn)(0);
}

function resultSpan(result: object | undefined) {
  if (result == null || !("startLine" in result) || !("endLine" in result))
    return ((pinnedReturn: { startLine?: number; endLine?: number }) => pinnedReturn)({});
  const startLine = result.startLine;
  const endLine = result.endLine;
  return ((pinnedReturn: { startLine?: number; endLine?: number }) => pinnedReturn)({
    ...(typeof startLine === "number" ? { startLine } : {}),
    ...(typeof endLine === "number" ? { endLine } : {}),
  });
}

function annotationWindow(
  requested: { readonly startLine?: number; readonly maxLines?: number },
  result?: object,
) {
  const span = resultSpan(result);
  if (requested.startLine != null || requested.maxLines != null) {
    const start = requested.startLine ?? 1;
    const end =
      requested.maxLines != null
        ? start + requested.maxLines - 1
        : span.endLine != null && span.endLine > 0
          ? span.endLine
          : start;
    return ((pinnedReturn: { start: number; end: number }) => pinnedReturn)({
      start,
      end: Math.max(start, end),
    });
  }
  if (span.startLine != null && span.startLine > 0 && span.endLine != null && span.endLine > 0) {
    return ((pinnedReturn: { start: number; end: number }) => pinnedReturn)({
      start: span.startLine,
      end: span.endLine,
    });
  }
  return ((pinnedReturn: { start: number; end: number }) => pinnedReturn)({
    start: 1,
    end: Number.MAX_SAFE_INTEGER,
  });
}

function diffAnnotationWindow(diff: string) {
  const ranges = parseCommentableRightLineRanges(diff);
  if (ranges.length === 0)
    return ((pinnedReturn: { start: number; end: number }) => pinnedReturn)({
      start: 1,
      end: Number.MAX_SAFE_INTEGER,
    });
  return ((pinnedReturn: { start: number; end: number }) => pinnedReturn)({
    start: Math.min(...ranges.map((range) => range[0])),
    end: Math.max(...ranges.map((range) => range[1])),
  });
}

function boundedThreadTitle(title: string) {
  const text = neutralizeForgedTrustHeaders(
    neutralizeEvidenceDelimiters(neutralizeMarkerEcho(title)),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= REVIEW_THREAD_TITLE_CAP) return ((pinnedReturn: string) => pinnedReturn)(text);
  return ((pinnedReturn: string) => pinnedReturn)(`${text.slice(0, REVIEW_THREAD_TITLE_CAP - 1)}…`);
}

function withoutDetail(entry: ReviewThreadFieldEntry) {
  const { detail: _detail, ...rest } = entry;
  return ((pinnedReturn: ReviewThreadFieldEntry) => pinnedReturn)(rest);
}

function withoutText(entry: ReviewThreadFieldEntry) {
  const { detail: _detail, title: _title, ...rest } = entry;
  return ((pinnedReturn: ReviewThreadFieldEntry) => pinnedReturn)(rest);
}

function reviewThreadFieldBytes(entries: readonly ReviewThreadFieldEntry[]) {
  return ((pinnedReturn: number) => pinnedReturn)(
    Buffer.byteLength(JSON.stringify(entries), "utf8"),
  );
}

function fitReviewThreadField(entries: ReviewThreadFieldEntry[]) {
  const fitted = [...entries];
  const over = () => reviewThreadFieldBytes(fitted) > REVIEW_THREAD_FIELD_MAX_BYTES;
  for (let index = fitted.length - 1; index >= 0 && over(); index -= 1) {
    const entry = fitted[index];
    if (entry?.detail != null) fitted[index] = withoutDetail(entry);
  }
  while (fitted.length > 1 && over()) fitted.pop();
  const last = fitted[0];
  if (last != null && over()) fitted[0] = withoutText(last);
  return ((pinnedReturn: ReviewThreadFieldEntry[]) => pinnedReturn)(fitted);
}

function reviewThreadField(
  threads: readonly OpenReviewThread[],
  path: string,
  window: { readonly start: number; readonly end: number },
  seen: Set<string>,
) {
  const matches = threads.filter((thread) => thread.path === path || thread.previousPath === path);
  if (matches.length === 0)
    return ((pinnedReturn: readonly ReviewThreadFieldEntry[] | undefined) => pinnedReturn)(
      undefined,
    );
  const ranked = matches.toSorted(
    (left, right) =>
      reviewThreadGap(window, left) - reviewThreadGap(window, right) ||
      (left.startLine ?? Number.MAX_SAFE_INTEGER) - (right.startLine ?? Number.MAX_SAFE_INTEGER) ||
      left.findingId.localeCompare(right.findingId),
  );
  const includeDetail = !seen.has(path);
  const entries = ranked.slice(0, REVIEW_THREAD_LIMIT).map((thread) => {
    const detail =
      thread.detail == null
        ? undefined
        : neutralizeForgedTrustHeaders(
            neutralizeEvidenceDelimiters(neutralizeMarkerEcho(thread.detail)),
          ).trim();
    return ((pinnedReturn: ReviewThreadFieldEntry) => pinnedReturn)({
      findingId: thread.findingId,
      severity: thread.severity,
      lens: thread.lens,
      startLine: thread.startLine,
      endLine: thread.endLine,
      ...(includeDetail
        ? {
            title: boundedThreadTitle(thread.title),
            ...(detail != null && detail.length > 0 ? { detail } : {}),
          }
        : {}),
    });
  });
  const fitted = fitReviewThreadField(entries);
  if (fitted.length === 0)
    return ((pinnedReturn: readonly ReviewThreadFieldEntry[] | undefined) => pinnedReturn)(
      undefined,
    );
  if (includeDetail) seen.add(path);
  return ((pinnedReturn: readonly ReviewThreadFieldEntry[] | undefined) => pinnedReturn)(fitted);
}

const DEFAULT_LOCAL_WORKSPACE_TOOL_LIMITS: LocalWorkspaceToolLimits = {
  maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
  readResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  diffResponseBytes: LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES,
  searchMaxFiles: LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  searchMaxTotalBytes: LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
};

export function createGovernedReviewEvidenceReader(
  workspace: PinnedRepositoryReader,
  headSha: string,
) {
  const gate = createAskPathGate();
  primePathGate(workspace, gate);
  const policy = createPathPolicy(workspace.agentCwd, { kind: "investigation", gate });
  let remainingReads = GOVERNED_EVIDENCE_MAX_READS;
  let remainingBytes = LOCAL_WORKSPACE_READ_RESPONSE_BYTES * GOVERNED_EVIDENCE_MAX_READS;
  return async (descriptor: EvidenceDescriptor) => {
    if (
      remainingReads <= 0 ||
      remainingBytes <= 0 ||
      descriptor.headSha !== headSha ||
      !policy.allows(descriptor.path) ||
      !workspace.isPathInCheckout(descriptor.path)
    )
      return ((pinnedReturn: (DeliveredFileRead | null) | Promise<DeliveredFileRead | null>) =>
        pinnedReturn)(null);
    remainingReads -= 1;
    try {
      await assertContainedWorkspacePath(workspace.agentCwd, descriptor.path);
      const result = await workspace.readFile(descriptor.path, policy, {
        maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
        maxResponseBytes: Math.min(LOCAL_WORKSPACE_READ_RESPONSE_BYTES, remainingBytes),
        window: {
          startLine: descriptor.startLine,
          maxLines: descriptor.endLine - descriptor.startLine + 1,
        },
      });
      if (result.refused || result.truncated)
        return ((pinnedReturn: (DeliveredFileRead | null) | Promise<DeliveredFileRead | null>) =>
          pinnedReturn)(null);
      remainingBytes -= Buffer.byteLength(result.content, "utf8");
      return ((pinnedReturn: (DeliveredFileRead | null) | Promise<DeliveredFileRead | null>) =>
        pinnedReturn)({
        path: descriptor.path,
        headSha,
        tool: "read_pinned",
        content: result.content,
        startLine: result.startLine,
        endLine: result.endLine,
        clampedLines: result.clampedLines,
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "pr_workspace.symlink_escape" ||
          error.code === "pr_workspace.path_traversal")
      )
        return ((pinnedReturn: (DeliveredFileRead | null) | Promise<DeliveredFileRead | null>) =>
          pinnedReturn)(null);
      throw error;
    }
  };
}

function primePathGate(
  workspace: PinnedRepositoryReader,
  pathGate: AskPathGate,
  extraAllowedPaths?: readonly string[],
) {
  pathGate.addPaths(workspace.changedFiles.map((file) => file.path));
  if (extraAllowedPaths?.length) {
    pathGate.addPaths(extraAllowedPaths);
  }
}

function coverageWarning(coverage: CheckoutCoverage) {
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
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    parts.length > 0 ? parts.join("; ") : undefined,
  );
}

function changedFileForPath(workspace: PinnedRepositoryReader, path: string) {
  return workspace.changedFileByPath.get(normalizeEvidencePath(path));
}

export function recordDiffEvidence(
  ledger: EvidenceLedger,
  params: {
    readonly path: string;
    readonly headSha: string;
    readonly tool: string;
    readonly diff: string;
  },
) {
  const contentHash = hashNormalizedLineText(params.diff);
  ledger.noteOpened(params.path);
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

function basenameOf(path: string) {
  return ((pinnedReturn: string) => pinnedReturn)(path.slice(path.lastIndexOf("/") + 1));
}

function sameDirEntries(normalized: string, checkoutPaths: readonly string[]) {
  const slash = normalized.lastIndexOf("/");
  const dir = slash === -1 ? "" : normalized.slice(0, slash + 1);
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1);
  const entries = checkoutPaths.filter((entry) => {
    if (!entry.startsWith(dir)) return false;
    const rest = entry.slice(dir.length);
    return rest.length > 0 && !rest.includes("/");
  });
  return ((pinnedReturn: { readonly filename: string; readonly entries: string[] }) =>
    pinnedReturn)({ filename, entries });
}

function canonicalizeFilename(name: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    name
      .normalize("NFC")
      .replace(/[\u202f\u00a0]/g, " ")
      .replace(/[\u2019\u2018]/g, "'"),
  );
}

function findUnicodeEquivalentPath(normalized: string, checkoutPaths: readonly string[]) {
  const { filename, entries } = sameDirEntries(normalized, checkoutPaths);
  if (filename.length === 0) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const target = canonicalizeFilename(filename);
  const matches = entries.filter(
    (entry) => entry !== normalized && canonicalizeFilename(basenameOf(entry)) === target,
  );
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    matches.length === 1 ? matches[0] : undefined,
  );
}

function bigramDiceSimilarity(a: string, b: string) {
  if (a === b) return ((pinnedReturn: number) => pinnedReturn)(1);
  if (a.length < 2 || b.length < 2) return ((pinnedReturn: number) => pinnedReturn)(0);
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
  return ((pinnedReturn: number) => pinnedReturn)((2 * common) / (a.length - 1 + (b.length - 1)));
}

function suggestSimilarPaths(
  normalized: string,
  checkoutPaths: readonly string[],
  policy: PathPolicy,
) {
  const { filename, entries } = sameDirEntries(normalized, checkoutPaths);
  const target = filename.toLowerCase();
  if (target.length === 0) return ((pinnedReturn: string[]) => pinnedReturn)([]);
  const scored: Array<{ path: string; score: number }> = [];
  for (const entry of entries) {
    if (entry === normalized) continue;
    const score = bigramDiceSimilarity(target, basenameOf(entry).toLowerCase());
    if (score >= LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY && policy.allows(entry)) {
      scored.push({ path: entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ((pinnedReturn: string[]) => pinnedReturn)(
    scored.slice(0, LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS).map((entry) => entry.path),
  );
}

async function searchRankedTerms(
  workspace: PinnedRepositoryReader,
  params: {
    readonly terms: readonly string[];
    readonly maxResults: number;
    readonly maxOutputBytes: number;
    readonly allowedPaths: readonly string[];
  },
  view: {
    readonly recordSearchTruncated: () => void;
    readonly checkoutCoverage: () => CheckoutCoverage;
  },
) {
  const fullCoverage = params.allowedPaths.length === workspace.sortedCheckoutPaths.length;
  const results = await Promise.all(
    params.terms.map(async (term) => ({
      term,
      result: await workspace.grepLiteral({
        query: term,
        maxResults: LOCAL_WORKSPACE_SEARCH_MAX_MATCHES,
        maxOutputBytes: Math.floor(params.maxOutputBytes / params.terms.length),
        ...(fullCoverage ? {} : { paths: params.allowedPaths }),
      }),
    })),
  );
  const byPath = new Map<
    string,
    { readonly terms: Set<string>; readonly lines: Map<number, string> }
  >();
  for (const { term, result } of results) {
    for (const match of result.matches.slice(0, LOCAL_WORKSPACE_SEARCH_MAX_MATCHES)) {
      let file = byPath.get(match.path);
      if (file == null) {
        file = { terms: new Set(), lines: new Map() };
        byPath.set(match.path, file);
      }
      file.terms.add(term);
      file.lines.set(match.line, match.text);
    }
  }
  const ranked = [...byPath.entries()].toSorted(
    ([pathA, a], [pathB, b]) =>
      b.terms.size - a.terms.size || b.lines.size - a.lines.size || pathA.localeCompare(pathB),
  );
  const matches: { path: string; line: number; text: string }[] = [];
  for (const [path, file] of ranked) {
    for (const [line, text] of [...file.lines.entries()].toSorted(([a], [b]) => a - b)) {
      matches.push({ path, line, text });
    }
  }
  const truncated =
    results.some(
      ({ result }) =>
        result.truncated || result.matches.length > LOCAL_WORKSPACE_SEARCH_MAX_MATCHES,
    ) || matches.length > params.maxResults;
  if (truncated) view.recordSearchTruncated();
  const coverage = view.checkoutCoverage();
  const warning = truncated ? coverageWarning(coverage) : undefined;
  return {
    files: ranked.slice(0, params.maxResults).map(([path, file]) => ({
      path,
      terms: params.terms.filter((term) => file.terms.has(term)),
    })),
    matches: matches.slice(0, params.maxResults),
    truncated,
    pathsSearched: params.allowedPaths.length,
    filesScanned: byPath.size,
    ...(truncated ? { coverage, ...(warning ? { warning } : {}) } : {}),
  };
}

function diffEvidenceFields(evidence: WorkspacePathDiff, diff: string) {
  return {
    diff,
    availability: evidence.availability,
    reason: evidence.reason,
    ...(evidence.reason === "rename_previous_path" ? { currentPath: evidence.currentPath } : {}),
  };
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
    readonly reviewThreads?: ReviewThreadSource;
  },
) {
  const limits = opts?.limits ?? DEFAULT_LOCAL_WORKSPACE_TOOL_LIMITS;
  const pathGate = opts?.pathGate ?? createAskPathGate();
  const evidenceLedger = opts?.evidenceLedger;
  const headSha = opts?.headSha ?? evidenceLedger?.headSha;
  const readReviewThreads = opts?.reviewThreads;
  const seenReviewThreadPaths = new Set<string>();
  let searchTruncated = false;
  const recordSearchTruncated = () => {
    searchTruncated = true;
  };
  const checkoutCoverage = () => {
    const coverage = workspace.getCoverage();
    return ((pinnedReturn: CheckoutCoverage) => pinnedReturn)(
      searchTruncated ? { ...coverage, searchTruncated: true } : coverage,
    );
  };
  const spillPaths: string[] = [];
  const withReviewThreads = <T extends Record<string, unknown>>(
    payload: T,
    path: string,
    window: { readonly start: number; readonly end: number },
  ) => {
    if (readReviewThreads == null) return payload;
    const reviewThreads = reviewThreadField(
      readReviewThreads(),
      path,
      window,
      seenReviewThreadPaths,
    );
    return reviewThreads == null ? payload : { ...payload, reviewThreads };
  };
  const policy = createPathPolicy(workspace.agentCwd, { kind: "investigation", gate: pathGate });
  primePathGate(workspace, pathGate, opts?.extraAllowedPaths);

  const listChangedFiles = defineLocalTool({
    description:
      "List the files this pull request changes. Each entry has its path, the previous path when the file was renamed, its status, and whether the file exists in the PR head checkout. The other tools take paths from this list. Omit continuation to read the first page. Pass the returned continuation until it is null. files stays an array on every page. total is the number of files admitted for this head. truncated true means the pull request changes more files than this list admits, separate from another page of admitted files.",
    schema: v.object({
      continuation: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description("Token from the previous page. Omit it to read the first page."),
        ),
      ),
    }),
    run: async ({ continuation }) => {
      const listedHead = workspace.headSha;
      const reviewedHead = opts?.headSha;
      if (
        reviewedHead !== undefined &&
        listedHead.length > 0 &&
        reviewedHead.toLowerCase() !== listedHead.toLowerCase()
      ) {
        throw new AppError({
          domain: "tool",
          kind: "input_validation_failed",
          message:
            "listChangedFiles validation failed: the workspace head does not match the reviewed head.",
          context: { toolName: "listChangedFiles" },
        });
      }
      const boundHead = reviewedHead ?? listedHead;
      if (boundHead.length === 0) {
        throw new AppError({
          domain: "tool",
          kind: "input_validation_failed",
          message: "listChangedFiles validation failed: the workspace has no head.",
          context: { toolName: "listChangedFiles" },
        });
      }
      const paged = pageChangedFiles({
        files: workspace.changedFiles.map((file) => ({
          path: file.path,
          status: file.status,
          presentInCheckout: workspace.checkoutPaths.has(file.path),
          ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
        })),
        headSha: boundHead,
        truncated: workspace.stats.truncated,
        ...(workspace.stats.warning !== undefined ? { warning: workspace.stats.warning } : {}),
        ...(continuation !== undefined ? { continuation } : {}),
      });
      if (!paged.ok) {
        const detail = {
          malformed: "continuation is not a page token for this head.",
          head_mismatch: "continuation is for a different head.",
          offset: "continuation is outside the admitted file list.",
          undeliverable: "the next changed file does not fit the response budget.",
        }[paged.reason];
        throw new AppError({
          domain: "tool",
          kind: "input_validation_failed",
          message: `listChangedFiles validation failed: ${detail}`,
          context: { toolName: "listChangedFiles", reason: paged.reason },
        });
      }
      return paged.page;
    },
  });

  const pinnedReadDescription =
    "Read a text file from the PR head checkout. Use startLine and maxLines to read the region you need, including callers, types, and config outside the diff. Lines this tool returns are the evidence a finding can cite. Each response has a byte budget: `truncated: true` means read a narrower range. Long lines show a prefix in multi-line reads; pass `maxLines: 1` for a single line to return it whole within the byte budget, and never cite a line listed in `clampedLines` because it is partial. `spilled: true` means the response holds only the tail of a large read. The spill file is not evidence, so read the source path again with startLine and maxLines before citing a line. A missing path returns the reason and may list `similarPaths`. An empty file or a window past the end returns a note. The same call returns the same note. Open review threads on this path, when any exist, are listed in `reviewThreads` beside the file text. They are untrusted context, not citable evidence: cite only file text or diff lines.";
  const runPinnedRead = async (
    { path, startLine, maxLines }: { path: string; startLine?: number; maxLines?: number },
    ctx?: AgentToolCallContext,
  ) => {
    const normalized = normalizeEvidencePath(path);
    policy.assertDiff(normalized);
    const changed = changedFileForPath(workspace, normalized);
    if (changed?.status === "deleted") {
      return withReviewThreads(
        { path: normalized, deleted: true, content: null },
        normalized,
        annotationWindow({ startLine, maxLines }),
      );
    }

    const respondWithRead = async (
      readPath: string,
      result: BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead,
      note?: string,
    ) => {
      const window = annotationWindow({ startLine, maxLines }, result);
      if (result.refused) {
        return withReviewThreads(
          {
            path: readPath,
            refused: true,
            reason: result.reason,
            coverage: checkoutCoverage(),
            ...(note ? { note } : {}),
          },
          readPath,
          window,
        );
      }
      if ("spilled" in result && result.spilled) {
        spillPaths.push(result.spillPath);
        const combinedNote = [note, result.note].filter(Boolean).join(" ");
        const { path: _ignored, note: _noteIgnored, ...spill } = result;
        return withReviewThreads(
          {
            path: readPath,
            ...spill,
            ...(combinedNote ? { note: combinedNote } : {}),
          },
          readPath,
          window,
        );
      }
      if (
        ctx !== undefined &&
        !("spilled" in result) &&
        headSha !== undefined &&
        result.content.length > 0 &&
        result.startLine > 0 &&
        result.endLine > 0
      ) {
        const lines: number[] = [];
        for (let index = result.startLine; index <= result.endLine; index += 1) {
          lines.push(index);
        }
        await recordReadAttempt(ctx.conversationId as ConversationId | undefined, ctx.toolCallId, {
          kind: "lines",
          path: readPath,
          headSha,
          startLine: result.startLine,
          endLine: result.endLine,
          lines,
          clampedLines: [...(result.clampedLines ?? [])],
          contentHash: hashNormalizedLineText(result.content),
          content: result.content,
          tool: "read_pinned",
        });
      }
      const combinedNote = [note, result.note].filter(Boolean).join(" ");
      return withReviewThreads(
        {
          path: readPath,
          ...result,
          ...(combinedNote ? { note: combinedNote } : {}),
        },
        readPath,
        window,
      );
    };

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
      return withReviewThreads(
        {
          path: normalized,
          refused: true,
          reason: MISSING_FROM_CHECKOUT_REASON,
          coverage: checkoutCoverage(),
          ...(similarPaths.length > 0 ? { similarPaths } : {}),
        },
        normalized,
        annotationWindow({ startLine, maxLines }),
      );
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
  };

  const searchWorkspace = defineLocalTool({
    description:
      "Search every readable file in the PR head checkout for literal text, matched case-sensitively. Use it to find callers, definitions, and config outside the diff. The search skips binary files. Pass `terms` with related literals, for example a function name, its error code, and its config key. This ranks files by how many of `query` and `terms` they contain. The response lists those files in `files`, best first, and `matches` follows that order. `truncated: true` means more matches exist than the response returned, so search for more specific text. `pathsSearched` counts the checkout paths scanned; `filesScanned` counts the files that matched.",
    schema: v.object({
      query: literalQueryParam,
      terms: v.optional(
        v.pipe(
          v.array(literalQueryParam),
          v.maxLength(LOCAL_WORKSPACE_SEARCH_MAX_TERMS),
          v.description(
            "More exact texts to rank files by, alongside query. Each is matched literally.",
          ),
        ),
      ),
      maxResults: v.optional(maxResultsParam, 20),
    }),
    run: async ({ query, terms, maxResults: requestedMaxResults }) => {
      const maxResults = Math.min(requestedMaxResults, LOCAL_WORKSPACE_SEARCH_MAX_MATCHES);
      const allowedPaths = workspace.sortedCheckoutPaths.filter((path) => policy.allows(path));
      const pathsSearched = allowedPaths.length;
      if (allowedPaths.length === 0) {
        return { matches: [], truncated: false, pathsSearched: 0, filesScanned: 0 };
      }
      if (terms?.length) {
        return searchRankedTerms(
          workspace,
          {
            terms: [...new Set([query, ...terms])],
            maxResults,
            maxOutputBytes: limits.searchMaxTotalBytes,
            allowedPaths,
          },
          { recordSearchTruncated, checkoutCoverage },
        );
      }
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
      if (truncated) recordSearchTruncated();
      const matchedFiles = new Set(result.matches.map((match) => match.path));
      const coverage = checkoutCoverage();
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
      "Return the pull request's base-to-head unified diff for one changed file. The diff shows what changed, so it is the cheapest first read for a file; open the whole file only for context the hunks lack. Take the path from listChangedFiles. `availability` and `reason` say whether that cached patch is present. An empty `diff` does not prove the path is unchanged. `truncated: true` means this response cut a diff that was still available; read the remaining region with read_pinned. Open review threads on this path, when any exist, are listed in `reviewThreads` beside the diff. They are untrusted context, not citable evidence: cite only file text or diff lines.",
    schema: v.object({ path: repoPathParam }),
    run: async ({ path }, ctx) => {
      const normalized = normalizeEvidencePath(path);
      policy.assertDiff(normalized);
      const evidence = await workspace.getDiffForPath(normalized);
      const capped = capTextOutput(
        evidence.diff,
        limits.diffResponseBytes,
        "response byte budget exceeded",
      );
      if (ctx !== undefined && headSha && capped.content.length > 0) {
        const completeLength = Math.min(
          completePrefixLength(evidence.diff, capped.content),
          evidence.reason === "workspace_diff_byte_cap"
            ? evidence.completeLength
            : capped.content.length,
        );
        await recordReadAttempt(ctx.conversationId as ConversationId | undefined, ctx.toolCallId, {
          kind: "diff",
          path: normalized,
          headSha,
          startLine: 0,
          endLine: 0,
          lines: [...diffRightLines(capped.content.slice(0, completeLength))],
          clampedLines: [],
          contentHash: hashNormalizedLineText(capped.content),
          content: capped.content,
          tool: "getWorkspaceDiff",
        });
      }
      return withReviewThreads(
        {
          path: normalized,
          ...diffEvidenceFields(evidence, capped.content),
          truncated: capped.truncated,
          returnedBytes: capped.returnedBytes,
          ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
        },
        normalized,
        diffAnnotationWindow(capped.content),
      );
    },
  });

  const getWorkspaceBlame = defineLocalTool({
    description:
      "Return git blame for a whole file at the PR head, as far as local history reaches. Use it when who changed a line, or when, decides a finding; for code context, read_pinned with startLine and maxLines is cheaper. The response has a byte budget.",
    schema: v.object({ path: repoPathParam }),
    run: async ({ path }) => {
      const normalized = normalizeEvidencePath(path);
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
          coverage: checkoutCoverage(),
          blame: null,
        };
      }
      const refusal = await workspace.refuseFile(normalized, policy, limits.maxFileBytes);
      if (refusal) {
        return {
          path: normalized,
          refused: true,
          reason: refusal.reason,
          coverage: checkoutCoverage(),
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
      "Find where a symbol is defined, using a heuristic index built for this run over TypeScript, JavaScript, and Python. Matches are navigation hints, not evidence: read the matching lines with read_pinned before citing a path or line.",
    schema: v.object({
      name: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Symbol name as written in code, for example `parseConfig`."),
      ),
      maxResults: v.optional(maxResultsParam, LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS),
    }),
    run: async ({ name, maxResults }) => {
      const status = workspace.getSymbolIndexStatus();
      const matches = workspace.lookupSymbol(name, maxResults);
      return {
        name,
        available: status.available,
        matches,
        ...(status.available ? {} : { reason: "Symbol index unavailable for this workspace." }),
        reminder: "Call read_pinned before citing any match.",
      };
    },
  });

  const findFiles = defineLocalTool({
    description:
      "Find files in the PR head checkout by path. Matching is fuzzy and case-insensitive, so part of a file name or directory, such as `prActorLease` or `migrations`, is enough. Returns paths only, best match first. Read a path with read_pinned before citing it. `truncated: true` means more paths matched.",
    schema: v.object({
      query: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Part of a file name or path, for example `prActorLease`."),
      ),
      maxResults: v.optional(maxResultsParam, 20),
    }),
    run: async ({ query, maxResults }) => {
      const allowedPaths = workspace.sortedCheckoutPaths.filter((path) => policy.allows(path));
      const fullCoverage = allowedPaths.length === workspace.sortedCheckoutPaths.length;
      return workspace.findFiles({
        query,
        maxResults,
        ...(fullCoverage ? {} : { paths: allowedPaths }),
      });
    },
  });

  const tools: Record<string, LocalTool> = {
    listChangedFiles,
    searchWorkspace,
    findFiles,
    getWorkspaceDiff,
    getWorkspaceBlame,
    resolveSymbol,
  };
  const toolMeta: Record<string, DurableToolMeta> = {
    ...Object.fromEntries(
      Object.keys(tools).map((name) => [name, { callers: ["model", "tools"] }]),
    ),
    read_pinned: { callers: ["model", "tools"], replay: "safe" },
    read_spill: { callers: ["model", "tools"], replay: "unsafe" },
    emitEvidence: { callers: ["tools"], replay: "safe" },
  };
  const durableTools = buildReadEvidenceTools({
    workspace,
    policy,
    headSha,
    spillScope: opts?.spillScope,
    readTool: {
      name: "read_pinned",
      description: pinnedReadDescription,
      replay: "safe",
      run: runPinnedRead,
    },
  });
  return ((pinnedReturn: {
    piTools: PiTool[];
    executors: Record<string, AgentRunnerToolExecutor>;
    durableTools: ToolRegistration[];
    toolMeta: Record<string, DurableToolMeta>;
    disposeSpillFiles: () => Promise<readonly string[]>;
    checkoutCoverage: () => CheckoutCoverage;
  }) => pinnedReturn)({
    ...defineToolset(tools),
    executors: {
      ...defineToolset(tools).executors,
      read_pinned: async (args: Record<string, unknown>, ctx?: AgentToolCallContext) =>
        runPinnedRead(v.parse(pinnedReadWindowSchema, args), ctx),
    },
    durableTools,
    toolMeta,
    checkoutCoverage,
    disposeSpillFiles: async () => {
      const paths = spillPaths.splice(0, spillPaths.length);
      const outcomes = await Promise.allSettled(
        paths.map((spillPath) => disposeSpillFile(spillPath)),
      );
      return paths.filter((_, index) => outcomes[index]?.status === "rejected");
    },
  });
}

const workspaceExecutionModes = new Map<string, "sequential">();
export function workspaceToolExecutionMode(name: string) {
  return ((pinnedReturn: "sequential" | undefined) => pinnedReturn)(
    workspaceExecutionModes.get(name),
  );
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
  const runVerificationRead = async ({
    path,
    startLine,
    maxLines,
  }: {
    path: string;
    startLine?: number;
    maxLines?: number;
  }) => {
    const result = await workspace.readFile(path, policy, {
      maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
      maxResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
      window: { startLine, maxLines },
    });
    if (result.refused) {
      return { path, refused: true, reason: result.reason };
    }
    return { path, ...result };
  };

  const searchWorkspace = defineLocalTool({
    description:
      "Search the pull request's repository view for literal text, matched case-sensitively. Sensitive and control paths are left out, and `filtered: true` says some matches were removed. `truncated: true` means more matches exist, so search for more specific text.",
    schema: v.object({
      query: literalQueryParam,
      maxResults: v.optional(maxResultsParam, 20),
    }),
    run: async ({ query, maxResults: requestedMaxResults }) => {
      const maxResults = Math.min(requestedMaxResults, LOCAL_WORKSPACE_SEARCH_MAX_MATCHES);
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
    description:
      "Return the pull request's base-to-head unified diff for one path, as GitHub reports it. `availability` is `available`, `unchanged`, or `unavailable`, and `reason` says why the diff is missing or partial. An empty `diff` does not prove the path is unchanged. `unchanged` means the changed-file list is complete and does not include the path.",
    schema: v.object({ path: repoPathParam }),
    run: async ({ path }) => {
      const rel = policy.assertDiff(path);
      const evidence = await workspace.getDiffForPath(rel);
      return { path: rel, ...diffEvidenceFields(evidence, evidence.diff) };
    },
  });

  const local = defineToolset({ searchWorkspace, getWorkspaceDiff });
  return {
    piTools: local.piTools,
    executors: {
      ...local.executors,
      read_pinned: async (args: Record<string, unknown>) =>
        runVerificationRead(v.parse(pinnedReadWindowSchema, args)),
    },
    durableTools: [
      durableReadTool({
        name: "read_pinned",
        description:
          "Read a text file from the pull request's repository view. Use startLine and maxLines for long files. Sensitive and control paths return `refused` with a reason.",
        replay: "safe",
        run: runVerificationRead,
      }),
    ],
    toolMeta: {},
  };
}

function buildTriageReadTools(workspace: RepositoryReader) {
  const root = workspace.agentCwd;
  const policy = createPathPolicy(root, { kind: "triage" });
  const runTriageRead = async ({
    path,
    startLine,
    maxLines,
  }: {
    path: string;
    startLine?: number;
    maxLines?: number;
  }) => {
    const result = await workspace.readFile(path, policy, {
      maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
      maxResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
      window: { startLine, maxLines },
    });
    if (result.refused) {
      return { path, refused: true, reason: result.reason };
    }
    return { path, ...result };
  };

  const searchWorkspace = defineLocalTool({
    description:
      "Search the writable PR checkout for literal text with git grep. Sensitive and control paths are left out, and `filtered: true` says some matches were removed. `truncated: true` means more matches exist, so search for more specific text.",
    schema: v.object({
      query: literalQueryParam,
      maxResults: v.optional(maxResultsParam, 20),
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
      'Return uncommitted changes for one file in the writable checkout. Tracked edits use `git diff HEAD`. A new untracked file is an available diff of that file. `availability: "unchanged"` means the tracked file matches the PR head.',
    schema: v.object({ path: repoPathParam }),
    run: async ({ path }) => {
      const rel = policy.assertDiff(path);
      const evidence = await workspace.getDiffForPath(rel);
      return { path: rel, ...diffEvidenceFields(evidence, evidence.diff) };
    },
  });

  const local = defineToolset({ searchWorkspace, getWorkspaceDiff });
  return {
    piTools: local.piTools,
    executors: {
      ...local.executors,
      read_triage: async (args: Record<string, unknown>) =>
        runTriageRead(v.parse(pinnedReadWindowSchema, args)),
    },
    durableTools: [
      durableReadTool({
        name: "read_triage",
        description:
          "Read a text file from the writable PR checkout, including edits made earlier in this run. Use startLine and maxLines for long files. Sensitive and control paths return `refused` with a reason.",
        replay: "unsafe",
        run: runTriageRead,
      }),
    ],
    toolMeta: {},
  };
}

export function buildWorkspaceTools(
  workspace: PinnedRepositoryReader,
  opts?: Parameters<typeof buildInvestigationTools>[1],
): ReturnType<typeof buildInvestigationTools>;
export function buildWorkspaceTools(
  params:
    | { readonly profile: "verification"; readonly reader: PinnedRepositoryReader }
    | { readonly profile: "triage"; readonly reader: RepositoryReader },
): ReturnType<typeof defineToolset> & WorkspaceToolBundle;
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

const SPILL_EXPIRED_MESSAGE =
  "The run spill is no longer available; its scratch files are gone after the run ends.";

type ReadEvidenceToolsParams = {
  readonly readTool?: {
    readonly name: string;
    readonly description: string;
    readonly replay: "safe" | "unsafe";
    readonly run: (
      input: { path: string; startLine?: number; maxLines?: number },
      ctx?: AgentToolCallContext,
    ) => Promise<unknown>;
  };
  readonly workspace: PinnedRepositoryReader;
  readonly policy: PathPolicy;
  readonly headSha: string | undefined;
  readonly spillScope?: TextSpillScope;
};

const pinnedReadWindowSchema = v.object({
  path: repoPathParam,
  startLine: startLineParam,
  maxLines: maxLinesParam,
});

const readWindowJsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Repo-relative path." },
    startLine: { type: "number", description: "First 1-indexed line." },
    maxLines: { type: "number", description: "Maximum lines to return." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

async function recordReadAttempt(
  conversationId: ConversationId | undefined,
  toolCallId: string,
  attempt: EvidenceReadAttempt,
) {
  if (conversationId === undefined) return;
  const state = sessionStateFor(conversationId);
  if (!state) return;
  await state.journal?.read(toolCallId, attempt);
  const reads = state.evidence.attempts.get(toolCallId) ?? [];
  if (!includesEvidenceRead(reads, attempt))
    state.evidence.attempts.set(toolCallId, [...reads, attempt]);
}

function errorResult(message: string) {
  return ((pinnedReturn: ToolExecutionResult) => pinnedReturn)({
    output: [{ type: "text", text: message }],
    isError: true,
  });
}

export function durableReadTool(options: {
  readonly name: string;
  readonly description: string;
  readonly replay: "safe" | "unsafe";
  readonly run: (
    input: { path: string; startLine?: number; maxLines?: number },
    ctx?: AgentToolCallContext,
  ) => Promise<unknown>;
}) {
  const tool: ToolRegistration = {
    name: options.name,
    description: options.description,
    replay: options.replay,
    parameters: readWindowJsonSchema,
    execute: async (args, api, context) => {
      const input = v.parse(pinnedReadWindowSchema, args);
      const result = await options.run(input, {
        signal: context.abortSignal ?? new AbortController().signal,
        conversationId: api.conversationId,
        toolCallId: api.callId,
      });
      return ((pinnedReturn: ToolExecutionResult) => pinnedReturn)({
        output: [{ type: "text", text: JSON.stringify(result) }],
      });
    },
  };
  return tool;
}

function buildReadEvidenceTools(params: ReadEvidenceToolsParams) {
  const { workspace, policy, headSha } = params;
  const root = workspace.agentCwd;
  const base = createReadTool();

  const resolvePolicyPath = async (rawPath: string) => {
    const normalized = policy.assertDiff(rawPath.replace(/\\/g, "/").normalize("NFC"));
    const contained = await assertContainedWorkspacePath(root, normalized);
    const resolved = await realpath(contained);
    const realRoot = await realpath(root);
    if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
      throw new AppError({
        domain: "pr_workspace",
        kind: "symlink_escape",
        message: `Symlink escape blocked: ${rawPath}`,
        context: { path: rawPath },
      });
    }
    const repoRelative = normalizeRepoRelativePath(relative(realRoot, resolved));
    if (!policy.allows(repoRelative) || isSensitivePath(repoRelative)) {
      throw new AppError({
        domain: "ask",
        kind: "sensitive_path_blocked",
        message: `Blocked sensitive path "${repoRelative}"`,
        context: { path: repoRelative },
      });
    }
    return ((
      pinnedReturn:
        | { resolved: string; repoRelative: string }
        | Promise<{ resolved: string; repoRelative: string }>,
    ) => pinnedReturn)({ resolved, repoRelative });
  };

  const readSpill: ToolRegistration = {
    ...base,
    name: "read_spill",
    description:
      "Read a text file from this run's scratch spill area, for example a captured codemode output file. The spill expires when the run ends.",
    replay: "unsafe",
    async execute(args, api, context) {
      const raw = v.parse(v.object({ path: v.string() }), args).path;
      const state = sessionStateFor(api.conversationId);
      const roots = state === undefined ? [] : [...state.evidence.spillRoots];
      if (roots.length === 0 || state?.evidence.spillExpired === true) {
        return errorResult(SPILL_EXPIRED_MESSAGE);
      }
      for (const spillRoot of roots) {
        try {
          const contained = await assertContainedWorkspacePath(spillRoot, raw);
          const resolved = await realpath(contained);
          const realRoot = await realpath(spillRoot);
          if (
            (resolved === realRoot || resolved.startsWith(realRoot + sep)) &&
            !isSensitivePath(raw.normalize("NFC"))
          ) {
            return await base.execute({ path: resolved }, api, context);
          }
        } catch {
          continue;
        }
      }
      return errorResult(SPILL_EXPIRED_MESSAGE);
    },
  };

  const emitEvidence: ToolRegistration = {
    name: "emitEvidence",
    description:
      "Emit an evidence block for complete file lines from the PR head checkout so a finding can cite them. Returns the lines verbatim between a path and line-range header; only call it with lines you need as citation evidence.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path from the PR head checkout." },
        startLine: { type: "number", description: "First 1-indexed line." },
        endLine: { type: "number", description: "Last 1-indexed line." },
      },
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
    },
    callers: ["tools"],
    replay: "safe",
    async execute(args, api) {
      const input = v.parse(
        v.object({ path: v.string(), startLine: v.number(), endLine: v.number() }),
        args,
      );
      const raw = input.path;
      const startLine = Math.trunc(input.startLine);
      const endLine = Math.trunc(input.endLine);
      if (startLine < 1 || endLine < startLine) {
        return errorResult("emitEvidence requires 1 <= startLine <= endLine.");
      }
      try {
        const { repoRelative } = await resolvePolicyPath(raw);
        const result = await workspace.readFile(repoRelative, policy, {
          maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
          maxResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
          window: { startLine, maxLines: endLine - startLine + 1 },
        });
        if (result.refused) {
          return errorResult(`emitEvidence refused: ${result.reason}`);
        }
        if ("spilled" in result) {
          return errorResult("emitEvidence refused: the requested range spills; narrow it.");
        }
        const clamped = new Set(result.clampedLines);
        const sourceLines = result.content.replace(/\r\n/g, "\n").split("\n");
        const kept: { line: number; text: string }[] = [];
        for (let index = 0; index < result.endLine - result.startLine + 1; index += 1) {
          const line = result.startLine + index;
          const text = sourceLines[index];
          if (text === undefined || clamped.has(line)) continue;
          kept.push({ line, text });
        }
        if (kept.length === 0) {
          return errorResult("emitEvidence refused: no complete lines in range.");
        }
        const body = kept.map((entry) => entry.text).join("\n");
        const bodyHash = hashNormalizedLineText(body);
        const block = `${repoRelative}:${kept[0]?.line}-${kept.at(-1)?.line} sha256:${bodyHash}\n\`\`\`\n${body}\n\`\`\``;
        const head = headSha ?? "";
        if (head.length > 0) {
          await recordReadAttempt(api.conversationId, api.callId, {
            kind: "block",
            path: repoRelative,
            headSha: head,
            startLine: kept[0]?.line ?? startLine,
            endLine: kept.at(-1)?.line ?? endLine,
            lines: kept.map((entry) => entry.line),
            clampedLines: [],
            contentHash: bodyHash,
            content: body,
            tool: "emitEvidence",
          });
        }
        const first = kept[0];
        const last = kept.at(-1);
        return ((pinnedReturn: ToolExecutionResult) => pinnedReturn)({
          output: [{ type: "text", text: block }],
          details:
            first !== undefined && last !== undefined
              ? { path: repoRelative, startLine: first.line, endLine: last.line }
              : { path: repoRelative },
        });
      } catch (error) {
        if (error instanceof AppError) return errorResult(error.message);
        throw error;
      }
    },
  };

  const tools: ToolRegistration[] = [readSpill, emitEvidence];
  if (params.readTool !== undefined) {
    tools.unshift(durableReadTool(params.readTool));
  }
  return ((pinnedReturn: ToolRegistration[]) => pinnedReturn)(tools);
}

export type WorkspaceToolBundle = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly durableTools: readonly ToolRegistration[];
  readonly toolMeta: Readonly<Record<string, DurableToolMeta>>;
};

export function hideWorkspaceToolsBehindCodeMode(bundle: WorkspaceToolBundle) {
  const toolMeta: Record<string, DurableToolMeta> = { ...bundle.toolMeta };
  for (const name of Object.keys(bundle.executors)) {
    toolMeta[name] = { callers: ["tools"] };
  }
  return ((pinnedReturn: WorkspaceToolBundle) => pinnedReturn)({
    piTools: bundle.piTools,
    executors: bundle.executors,
    durableTools: bundle.durableTools,
    toolMeta,
  });
}
