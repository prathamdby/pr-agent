import { errorMessage } from "../../errors/errorMessage.ts";
import { logWarn } from "../../evlog.ts";
import type { PrSurface } from "../../github/prSurfaceTypes.ts";
import type {
  ListReviewThreadResolutionResult,
  ReviewThreadSnapshot,
} from "../../github/reviewThreadResolution.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../../settings/index.ts";
import type { FindingSource } from "../orchestrator/orchestratorTypes.ts";
import {
  isBotAuthor,
  legacyFindingId,
  neutralizeMarkerEcho,
  parseOwnedFindingMarker,
  parseOwnedFindingRows,
  parseOwnedReceipts,
  type FindingId,
  type FindingSeverity,
} from "./findingMarker.ts";

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

export function capFindingDetail(text: string) {
  const compact = neutralizeMarkerEcho(text).replace(/\s+/g, " ").trim();
  if (compact.length === 0) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (compact.length <= FINDING_DETAIL_CAP)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(compact);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    `${compact.slice(0, FINDING_DETAIL_CAP - 1)}…`,
  );
}

function visibleThreadDetail(body: string) {
  const heading = /^\*\*P[0-3]\*\* · \*\*.+?\*\*\s*$/m.exec(body);
  const afterTitle =
    heading?.index != null
      ? body.slice(heading.index + heading[0].length)
      : body.slice(body.indexOf("\n") + 1);
  const stripped = afterTitle.replace(HTML_COMMENT_RE, "").replace(PROMPT_TO_FIX_BLOCK_RE, "");
  return ((pinnedReturn: string | undefined) => pinnedReturn)(capFindingDetail(stripped));
}

function parseHeading(body: string) {
  const match = FINDING_HEADING_RE.exec(body);
  if (match == null)
    return ((pinnedReturn: { readonly severity: FindingSeverity; readonly title: string } | null) =>
      pinnedReturn)(null);
  const severity = match[1];
  if (severity !== "P0" && severity !== "P1" && severity !== "P2" && severity !== "P3")
    return ((pinnedReturn: { readonly severity: FindingSeverity; readonly title: string } | null) =>
      pinnedReturn)(null);
  return ((pinnedReturn: { readonly severity: FindingSeverity; readonly title: string } | null) =>
    pinnedReturn)({ severity, title: match[2].trim() });
}

function completenessOf(
  status: ListReviewThreadResolutionResult["status"],
  summaryComplete: boolean,
) {
  switch (status) {
    case "ok":
      return ((pinnedReturn: InventoryCompleteness) => pinnedReturn)(
        summaryComplete ? "complete" : "partial",
      );
    case "partial":
    case "unavailable":
    case "permission_denied":
      return ((pinnedReturn: InventoryCompleteness) => pinnedReturn)(status);
    default: {
      const exhaustive: never = status;
      return ((pinnedReturn: InventoryCompleteness) => pinnedReturn)(exhaustive);
    }
  }
}

function openThreadFromInventory(finding: InventoryFinding) {
  return ((pinnedReturn: OpenReviewThread) => pinnedReturn)({
    findingId: finding.id,
    severity: finding.severity,
    lens: finding.lens,
    path: finding.path,
    ...(finding.previousPath != null ? { previousPath: finding.previousPath } : {}),
    startLine: finding.startLine,
    endLine: finding.line,
    title: neutralizeMarkerEcho(finding.title),
    ...(finding.detail != null ? { detail: finding.detail } : {}),
  });
}

export function openReviewThreads(
  inventory: FindingInventory,
  accepted: readonly AcceptedOpenThread[],
) {
  const fromInventory = [...inventory.findings.values()]
    .filter((finding) => finding.state === "open")
    .map(openThreadFromInventory);
  const known = new Set(fromInventory.map((thread) => thread.findingId));
  const fromRun = accepted.flatMap((entry) => {
    if (known.has(entry.id)) return ((pinnedReturn: OpenReviewThread[]) => pinnedReturn)([]);
    const detail = entry.detail == null ? undefined : capFindingDetail(entry.detail);
    return ((pinnedReturn: OpenReviewThread[]) => pinnedReturn)([
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
    ]);
  });
  return ((pinnedReturn: readonly OpenReviewThread[]) => pinnedReturn)([
    ...fromInventory,
    ...fromRun,
  ]);
}

function placePath(rawPath: string, context: InventoryPathContext) {
  const renamed = context.renames.get(rawPath);
  const path = renamed ?? rawPath;
  return ((pinnedReturn: Pick<InventoryFinding, "path" | "previousPath" | "fileDeleted">) =>
    pinnedReturn)({
    path,
    ...(renamed != null && renamed !== rawPath ? { previousPath: rawPath } : {}),
    fileDeleted: context.deletedPaths.has(path),
  });
}

export function hasHumanReplies(thread: Pick<ReviewThreadSnapshot, "comments">, botLogin: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    thread.comments.slice(1).some((reply) => !isBotAuthor(reply.authorLogin, botLogin)),
  );
}

function threadFinding(
  thread: ReviewThreadSnapshot,
  botLogin: string,
  context: InventoryPathContext,
) {
  const [root] = thread.comments;
  if (root == null || thread.path == null || !isBotAuthor(root.authorLogin, botLogin))
    return ((pinnedReturn: InventoryFinding | null) => pinnedReturn)(null);
  const marker = parseOwnedFindingMarker(
    { body: root.body, authorLogin: root.authorLogin, isRoot: true },
    botLogin,
  );
  const heading = parseHeading(root.body);
  if (marker == null && heading == null)
    return ((pinnedReturn: InventoryFinding | null) => pinnedReturn)(null);
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
  return ((pinnedReturn: InventoryFinding | null) => pinnedReturn)({
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
  });
}

function isOlder(left: InventoryFinding, right: InventoryFinding) {
  if (left.createdAt !== right.createdAt)
    return ((pinnedReturn: boolean) => pinnedReturn)(left.createdAt < right.createdAt);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    (left.rootCommentId ?? 0) < (right.rootCommentId ?? 0),
  );
}

function canonicalResolver(findings: ReadonlyMap<FindingId, InventoryFinding>) {
  return ((pinnedReturn: (id: FindingId) => FindingId | null) => pinnedReturn)((start) => {
    const seen = new Set<FindingId>();
    let current = findings.get(start);
    while (current != null) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      if (current.aliasOf == null) return current.id;
      current = findings.get(current.aliasOf);
    }
    return null;
  });
}

export function buildFindingInventory(
  input: InventoryPathContext & {
    readonly threads: Pick<ListReviewThreadResolutionResult, "status" | "threads">;
    readonly summary: InventorySummaryComment | null;
    readonly summaryComplete: boolean;
    readonly botLogin: string;
  },
) {
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
  return ((pinnedReturn: FindingInventory) => pinnedReturn)({
    completeness: completenessOf(input.threads.status, input.summaryComplete),
    findings,
    sameIdCopies,
    canonicalOf: canonicalResolver(findings),
  });
}

async function readSummaryComment(surface: PrSurface, botLogin: string) {
  try {
    const comments = (await surface.listConversationComments()).comments;
    const summary = comments.findLast(
      (comment) =>
        comment.body.startsWith(REVIEW_SUMMARY_SENTINEL) &&
        isBotAuthor(comment.authorLogin, botLogin),
    );
    if (summary == null)
      return ((
        pinnedReturn:
          | { readonly summary: InventorySummaryComment | null; readonly complete: boolean }
          | Promise<{
              readonly summary: InventorySummaryComment | null;
              readonly complete: boolean;
            }>,
      ) => pinnedReturn)({ summary: null, complete: true });
    return ((
      pinnedReturn:
        | { readonly summary: InventorySummaryComment | null; readonly complete: boolean }
        | Promise<{ readonly summary: InventorySummaryComment | null; readonly complete: boolean }>,
    ) => pinnedReturn)({
      summary: {
        body: summary.body,
        authorLogin: summary.authorLogin,
        url: `https://github.com/${surface.owner}/${surface.repo}/pull/${surface.prNumber}#issuecomment-${summary.id}`,
      },
      complete: true,
    });
  } catch {
    return ((
      pinnedReturn:
        | { readonly summary: InventorySummaryComment | null; readonly complete: boolean }
        | Promise<{ readonly summary: InventorySummaryComment | null; readonly complete: boolean }>,
    ) => pinnedReturn)({ summary: null, complete: false });
  }
}

export async function loadFindingInventoryFromThreads(
  surface: PrSurface,
  input: InventoryPathContext & {
    readonly threads: Pick<ListReviewThreadResolutionResult, "status" | "threads">;
    readonly botLogin: string;
  },
) {
  const summary = await readSummaryComment(surface, input.botLogin);
  return ((pinnedReturn: FindingInventory | Promise<FindingInventory>) => pinnedReturn)(
    buildFindingInventory({
      threads: input.threads,
      summary: summary.summary,
      summaryComplete: summary.complete,
      botLogin: input.botLogin,
      renames: input.renames,
      deletedPaths: input.deletedPaths,
    }),
  );
}

export async function loadFindingInventory(surface: PrSurface, context: InventoryPathContext) {
  const botLogin = await surface.getBotLogin();
  const [threads, summary] = await Promise.all([
    surface
      .listInlineReviewThreads()
      .catch(() => ({ status: "unavailable" as const, threads: [] })),
    readSummaryComment(surface, botLogin),
  ]);
  return ((pinnedReturn: FindingInventory | Promise<FindingInventory>) => pinnedReturn)(
    buildFindingInventory({
      threads,
      summary: summary.summary,
      summaryComplete: summary.complete,
      botLogin,
      ...context,
    }),
  );
}

export function unavailableFindingInventory(context: InventoryPathContext) {
  return ((pinnedReturn: FindingInventory) => pinnedReturn)(
    buildFindingInventory({
      threads: { status: "unavailable", threads: [] },
      summary: null,
      summaryComplete: false,
      botLogin: "",
      ...context,
    }),
  );
}

export async function loadFindingInventoryOrUnavailable(
  surface: PrSurface,
  context: InventoryPathContext,
) {
  try {
    return ((pinnedReturn: FindingInventory | Promise<FindingInventory>) => pinnedReturn)(
      await loadFindingInventory(surface, context),
    );
  } catch (error) {
    logWarn("review_finding_inventory_failed", {
      owner: surface.owner,
      repo: surface.repo,
      pr: surface.prNumber,
      message: errorMessage(error),
    });
    return ((pinnedReturn: FindingInventory | Promise<FindingInventory>) => pinnedReturn)(
      unavailableFindingInventory(context),
    );
  }
}
