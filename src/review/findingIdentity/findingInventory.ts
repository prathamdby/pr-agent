import { errorMessage } from "../../errors/errorMessage.js";
import { logWarn } from "../../evlog.js";
import type { PrSurface } from "../../github/prSurfaceTypes.js";
import type {
  ListReviewThreadResolutionResult,
  ReviewThreadSnapshot,
} from "../../github/reviewThreadResolution.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../settings/index.js";
import type { FindingSource } from "../orchestrator/orchestratorTypes.js";
import {
  isBotAuthor,
  legacyFindingId,
  neutralizeMarkerEcho,
  parseOwnedFindingMarker,
  parseOwnedFindingRows,
  parseOwnedReceipts,
  type FindingId,
  type FindingSeverity,
} from "./findingMarker.js";

export type InventoryCompleteness = "complete" | "partial" | "unavailable" | "permission_denied";
export type FindingResolution = "fixed" | "dismissed" | "duplicate";
export type RenameMap = ReadonlyMap<string, string>;

export type InventoryFinding = {
  readonly id: FindingId;
  readonly source: "thread" | "summary";
  readonly legacy: boolean;
  readonly threadId?: string;
  readonly rootCommentId?: number;
  readonly url: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly startLine: number | null;
  readonly line: number | null;
  readonly positionStale: boolean;
  readonly state: "open" | "resolved";
  readonly resolution?: FindingResolution;
  readonly aliasOf?: FindingId;
  readonly reopens?: FindingId;
  readonly lens: FindingSource | "unknown";
  readonly severity: FindingSeverity | "unknown";
  readonly title: string;
  readonly detail?: string;
  readonly createdAt: string;
  readonly hasHumanReplies: boolean;
  readonly commentsComplete: boolean;
  readonly fileDeleted: boolean;
};

export type FindingInventory = {
  readonly completeness: InventoryCompleteness;
  readonly findings: ReadonlyMap<FindingId, InventoryFinding>;
  readonly sameIdCopies: readonly InventoryFinding[];
  readonly canonicalOf: (id: FindingId) => FindingId | null;
};

export type OpenReviewThread = {
  readonly findingId: string;
  readonly severity: string;
  readonly lens: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly title: string;
  readonly detail?: string;
};

export type AcceptedOpenThread = {
  readonly id: FindingId;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly detail?: string;
  readonly severity: InventoryFinding["severity"];
  readonly lens: InventoryFinding["lens"];
};

export type InventoryPathContext = {
  readonly renames: RenameMap;
  readonly deletedPaths: ReadonlySet<string>;
};

export type InventorySummaryComment = {
  readonly body: string;
  readonly authorLogin: string | null;
  readonly url: string;
};

const FINDING_HEADING_RE = /^\*\*(P[0-3])\*\* · \*\*(.+?)\*\*\s*$/m;
const FINDING_DETAIL_CAP = 400;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const PROMPT_TO_FIX_BLOCK_RE =
  /<details>\s*<summary>\s*Prompt to fix[\s\S]*?<\/summary>[\s\S]*?<\/details>/gi;

export function capFindingDetail(text: string): string | undefined {
  const compact = neutralizeMarkerEcho(text).replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  if (compact.length <= FINDING_DETAIL_CAP) return compact;
  return `${compact.slice(0, FINDING_DETAIL_CAP - 1)}…`;
}

function visibleThreadDetail(body: string): string | undefined {
  const heading = /^\*\*P[0-3]\*\* · \*\*.+?\*\*\s*$/m.exec(body);
  const afterTitle =
    heading?.index != null
      ? body.slice(heading.index + heading[0].length)
      : body.slice(body.indexOf("\n") + 1);
  const stripped = afterTitle.replace(HTML_COMMENT_RE, "").replace(PROMPT_TO_FIX_BLOCK_RE, "");
  return capFindingDetail(stripped);
}

function parseHeading(
  body: string,
): { readonly severity: FindingSeverity; readonly title: string } | null {
  const match = FINDING_HEADING_RE.exec(body);
  if (match == null) return null;
  const severity = match[1];
  if (severity !== "P0" && severity !== "P1" && severity !== "P2" && severity !== "P3") return null;
  return { severity, title: match[2].trim() };
}

function completenessOf(
  status: ListReviewThreadResolutionResult["status"],
  summaryComplete: boolean,
): InventoryCompleteness {
  switch (status) {
    case "ok":
      return summaryComplete ? "complete" : "partial";
    case "partial":
    case "unavailable":
    case "permission_denied":
      return status;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function openThreadFromInventory(finding: InventoryFinding): OpenReviewThread {
  return {
    findingId: finding.id,
    severity: finding.severity,
    lens: finding.lens,
    path: finding.path,
    ...(finding.previousPath != null ? { previousPath: finding.previousPath } : {}),
    startLine: finding.startLine,
    endLine: finding.line,
    title: neutralizeMarkerEcho(finding.title),
    ...(finding.detail != null ? { detail: finding.detail } : {}),
  };
}

export function openReviewThreads(
  inventory: FindingInventory,
  accepted: readonly AcceptedOpenThread[],
): readonly OpenReviewThread[] {
  const fromInventory = [...inventory.findings.values()]
    .filter((finding) => finding.state === "open")
    .map(openThreadFromInventory);
  const known = new Set(fromInventory.map((thread) => thread.findingId));
  const fromRun = accepted.flatMap((entry): OpenReviewThread[] => {
    if (known.has(entry.id)) return [];
    const detail = entry.detail == null ? undefined : capFindingDetail(entry.detail);
    return [
      {
        findingId: entry.id,
        severity: entry.severity,
        lens: entry.lens,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        title: neutralizeMarkerEcho(entry.title),
        ...(detail != null ? { detail } : {}),
      },
    ];
  });
  return [...fromInventory, ...fromRun];
}

function placePath(
  rawPath: string,
  context: InventoryPathContext,
): Pick<InventoryFinding, "path" | "previousPath" | "fileDeleted"> {
  const renamed = context.renames.get(rawPath);
  const path = renamed ?? rawPath;
  return {
    path,
    ...(renamed != null && renamed !== rawPath ? { previousPath: rawPath } : {}),
    fileDeleted: context.deletedPaths.has(path),
  };
}

export function hasHumanReplies(
  thread: Pick<ReviewThreadSnapshot, "comments">,
  botLogin: string,
): boolean {
  return thread.comments.slice(1).some((reply) => !isBotAuthor(reply.authorLogin, botLogin));
}

function threadFinding(
  thread: ReviewThreadSnapshot,
  botLogin: string,
  context: InventoryPathContext,
): InventoryFinding | null {
  const [root] = thread.comments;
  if (root == null || thread.path == null || !isBotAuthor(root.authorLogin, botLogin)) return null;
  const marker = parseOwnedFindingMarker(
    { body: root.body, authorLogin: root.authorLogin, isRoot: true },
    botLogin,
  );
  const heading = parseHeading(root.body);
  if (marker == null && heading == null) return null;
  const id = marker?.id ?? legacyFindingId(thread.threadNodeId);
  const receipts = parseOwnedReceipts(thread.comments, botLogin).filter(
    (receipt) => receipt.id === id,
  );
  const duplicate = receipts.find((receipt) => receipt.kind === "duplicate");
  const closing = receipts.findLast(
    (receipt) => receipt.kind === "fixed" || receipt.kind === "dismissed",
  );
  const resolution: FindingResolution | undefined = !thread.isResolved
    ? undefined
    : duplicate != null
      ? "duplicate"
      : closing?.kind === "fixed"
        ? "fixed"
        : "dismissed";
  const line = thread.line;
  const detail = visibleThreadDetail(root.body);
  return {
    id,
    source: "thread",
    legacy: marker == null,
    threadId: thread.threadNodeId,
    rootCommentId: thread.rootCommentId,
    url: root.url,
    ...placePath(thread.path, context),
    startLine: thread.startLine ?? line,
    line,
    positionStale: thread.isOutdated || line == null,
    state: thread.isResolved ? "resolved" : "open",
    ...(resolution != null ? { resolution } : {}),
    ...(duplicate?.kind === "duplicate" && duplicate.canonical !== id
      ? { aliasOf: duplicate.canonical }
      : {}),
    ...(marker?.reopens != null ? { reopens: marker.reopens } : {}),
    lens: marker?.lens ?? "unknown",
    severity: marker?.severity ?? heading?.severity ?? "unknown",
    title: heading?.title ?? root.body.split("\n")[0]?.trim() ?? "",
    ...(detail != null ? { detail } : {}),
    createdAt: root.createdAt,
    hasHumanReplies: hasHumanReplies(thread, botLogin),
    commentsComplete: thread.commentsComplete,
  };
}

function isOlder(left: InventoryFinding, right: InventoryFinding): boolean {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt;
  return (left.rootCommentId ?? 0) < (right.rootCommentId ?? 0);
}

function canonicalResolver(
  findings: ReadonlyMap<FindingId, InventoryFinding>,
): (id: FindingId) => FindingId | null {
  return (start) => {
    const seen = new Set<FindingId>();
    let current = findings.get(start);
    while (current != null) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      if (current.aliasOf == null) return current.id;
      current = findings.get(current.aliasOf);
    }
    return null;
  };
}

export function buildFindingInventory(
  input: InventoryPathContext & {
    readonly threads: Pick<ListReviewThreadResolutionResult, "status" | "threads">;
    readonly summary: InventorySummaryComment | null;
    readonly summaryComplete: boolean;
    readonly botLogin: string;
  },
): FindingInventory {
  const findings = new Map<FindingId, InventoryFinding>();
  const sameIdCopies: InventoryFinding[] = [];
  for (const thread of input.threads.threads) {
    const finding = threadFinding(thread, input.botLogin, input);
    if (finding == null) continue;
    const existing = findings.get(finding.id);
    if (existing == null) {
      findings.set(finding.id, finding);
    } else if (isOlder(finding, existing)) {
      findings.set(finding.id, finding);
      sameIdCopies.push(existing);
    } else {
      sameIdCopies.push(finding);
    }
  }
  if (input.summary != null) {
    for (const row of parseOwnedFindingRows(input.summary, input.botLogin)) {
      if (findings.has(row.id)) continue;
      findings.set(row.id, {
        id: row.id,
        source: "summary",
        legacy: false,
        url: input.summary.url,
        ...placePath(row.path, input),
        startLine: row.line,
        line: row.line,
        positionStale: row.line == null,
        state: "open",
        ...(row.reopens != null ? { reopens: row.reopens } : {}),
        lens: row.lens,
        severity: row.severity,
        title: row.title,
        createdAt: "",
        hasHumanReplies: false,
        commentsComplete: true,
      });
    }
  }
  return {
    completeness: completenessOf(input.threads.status, input.summaryComplete),
    findings,
    sameIdCopies,
    canonicalOf: canonicalResolver(findings),
  };
}

async function readSummaryComment(
  surface: PrSurface,
  botLogin: string,
): Promise<{ readonly summary: InventorySummaryComment | null; readonly complete: boolean }> {
  try {
    const comments = await surface.listConversationComments();
    const summary = comments.findLast(
      (comment) =>
        comment.body.startsWith(REVIEW_SUMMARY_SENTINEL) &&
        isBotAuthor(comment.authorLogin, botLogin),
    );
    if (summary == null) return { summary: null, complete: true };
    return {
      summary: {
        body: summary.body,
        authorLogin: summary.authorLogin,
        url: `https://github.com/${surface.owner}/${surface.repo}/pull/${surface.prNumber}#issuecomment-${summary.id}`,
      },
      complete: true,
    };
  } catch {
    return { summary: null, complete: false };
  }
}

export async function loadFindingInventoryFromThreads(
  surface: PrSurface,
  input: InventoryPathContext & {
    readonly threads: Pick<ListReviewThreadResolutionResult, "status" | "threads">;
    readonly botLogin: string;
  },
): Promise<FindingInventory> {
  const summary = await readSummaryComment(surface, input.botLogin);
  return buildFindingInventory({
    threads: input.threads,
    summary: summary.summary,
    summaryComplete: summary.complete,
    botLogin: input.botLogin,
    renames: input.renames,
    deletedPaths: input.deletedPaths,
  });
}

export async function loadFindingInventory(
  surface: PrSurface,
  context: InventoryPathContext,
): Promise<FindingInventory> {
  const botLogin = await surface.getBotLogin();
  const [threads, summary] = await Promise.all([
    surface
      .listInlineReviewThreads()
      .catch(() => ({ status: "unavailable" as const, threads: [] })),
    readSummaryComment(surface, botLogin),
  ]);
  return buildFindingInventory({
    threads,
    summary: summary.summary,
    summaryComplete: summary.complete,
    botLogin,
    ...context,
  });
}

export function unavailableFindingInventory(context: InventoryPathContext): FindingInventory {
  return buildFindingInventory({
    threads: { status: "unavailable", threads: [] },
    summary: null,
    summaryComplete: false,
    botLogin: "",
    ...context,
  });
}

export async function loadFindingInventoryOrUnavailable(
  surface: PrSurface,
  context: InventoryPathContext,
): Promise<FindingInventory> {
  try {
    return await loadFindingInventory(surface, context);
  } catch (error) {
    logWarn("review_finding_inventory_failed", {
      owner: surface.owner,
      repo: surface.repo,
      pr: surface.prNumber,
      message: errorMessage(error),
    });
    return unavailableFindingInventory(context);
  }
}
