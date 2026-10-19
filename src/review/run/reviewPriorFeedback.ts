import {
  DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET,
  MAX_PRIOR_INLINE_FEEDBACK_THREADS,
  MAX_PRIOR_INLINE_REPLY_CHARS,
  REVIEW_POINTER_BODY,
  VERIFICATION_STUB_MARKER,
  LEGACY_REVIEW_LENSES,
  LEGACY_REVIEW_POINTER_BODIES,
  isAnyReviewLens,
  type AnyReviewLens,
} from "../../settings/index.ts";
import type { PrSurface } from "../../github/prSurfaceTypes.ts";
import type { FindingId } from "../findingIdentity/findingMarker.ts";
import { commentCarriesObjectionAnswer, isBotAuthor } from "../findingIdentity/findingMarker.ts";
import {
  loadFindingInventory,
  unavailableFindingInventory,
  type FindingInventory,
  type InventoryFinding,
} from "../findingIdentity/findingInventory.ts";

export type PriorInlineFeedbackThread = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly botTitleSnippet: string;
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
  readonly replies?: readonly ReviewThreadReply[];
  readonly threadUrl: string;
};

export type FindingObjection = {
  readonly commentId: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorUserId: number;
  readonly association: string | null;
  readonly authorized: boolean;
  readonly body: string;
};

export type BotFindingThread = {
  readonly rootCommentId: number;
  readonly findingId?: FindingId;
  readonly lens: AnyReviewLens;
  readonly path: string;
  readonly line: number;
  readonly severity: "P0" | "P1" | "P2" | "P3" | null;
  readonly titleSnippet: string;
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
  readonly replies?: readonly ReviewThreadReply[];
  readonly hasTriageReply?: boolean;
  readonly verificationStubCommentId?: number;
  readonly objections?: readonly FindingObjection[];
  readonly findingExcerpt?: string;
  readonly threadUrl: string;
};

export type ReviewCommentGraphNode = {
  readonly id: number;
  readonly inReplyToId: number | null;
};

export type ReviewThreadComment = ReviewCommentGraphNode & {
  readonly pullRequestReviewId: number | null;
  readonly userId: number | null;
  readonly authorLogin?: string | null;
  readonly authorAssociation?: string | null;
  readonly authorType?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly htmlUrl: string;
};

export type AssembledBotReviewThread = {
  readonly rootCommentId: number;
  readonly findingId?: FindingId;
  readonly lens: AnyReviewLens;
  readonly path: string;
  readonly line: number;
  readonly rootBody: string;
  readonly htmlUrl: string;
  readonly comments: readonly ReviewThreadComment[];
  readonly humanReplies: readonly string[];
  readonly authorizedReplies: readonly string[];
  readonly untrustedReplies: readonly string[];
  readonly replies: readonly ReviewThreadReply[];
};

export type ReviewThreadReply = {
  readonly body: string;
  readonly userId: number | null;
  readonly authorAssociation: string | null;
  readonly authorType?: string;
};

const USABLE_REVIEW_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isUsableReviewTimestamp(value: string | undefined): value is string {
  return value != null && USABLE_REVIEW_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export const NORMALIZED_REVIEW_PRIOR_FEEDBACK_LENSES = [
  "review",
  ...LEGACY_REVIEW_LENSES,
] as const satisfies readonly AnyReviewLens[];

export function priorFeedbackLensesForSelection(
  currentLens: AnyReviewLens,
): ReadonlySet<AnyReviewLens> {
  if (currentLens === "review") {
    return new Set<AnyReviewLens>(NORMALIZED_REVIEW_PRIOR_FEEDBACK_LENSES);
  }
  return new Set<AnyReviewLens>([currentLens]);
}

const REVIEW_POINTER_LENS_MARKER_RE = /<!--\s*pr-agent:review-pointer\s+lens=([^\s>]+)\s*-->/;

export function parseReviewPointerLensMarker(body: string): AnyReviewLens | null {
  const match = REVIEW_POINTER_LENS_MARKER_RE.exec(body);
  if (!match) return null;
  const lens = match[1];
  return isAnyReviewLens(lens) ? lens : null;
}

export function classifyReviewLensFromPointerBody(body: string): AnyReviewLens | null {
  const markerLens = parseReviewPointerLensMarker(body);
  if (markerLens) return markerLens;
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[0])) return "review-security";
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[1])) return "review-quality";
  if (body.includes(LEGACY_REVIEW_POINTER_BODIES[2])) return "review-tests";
  if (body.includes(REVIEW_POINTER_BODY)) return "review";
  return null;
}

function resolveReviewLensFromPointerOrRecords(
  body: string,
  reviewId: number,
  publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>,
): AnyReviewLens | null {
  return classifyReviewLensFromPointerBody(body) ?? publishRecordLenses?.get(reviewId) ?? null;
}

function resolveCommentRootId(
  comment: ReviewCommentGraphNode,
  byId: Map<number, ReviewCommentGraphNode>,
  rootById: Map<number, number>,
): number {
  const cachedRoot = rootById.get(comment.id);
  if (cachedRoot != null) return cachedRoot;

  let current = comment;
  const seen = new Set<number>();
  const path: number[] = [];
  while (current.inReplyToId != null) {
    const currentCachedRoot = rootById.get(current.id);
    if (currentCachedRoot != null) {
      for (const id of path) {
        rootById.set(id, currentCachedRoot);
      }
      return currentCachedRoot;
    }
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.push(current.id);
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    current = parent;
  }

  const rootId = current.id;
  rootById.set(rootId, rootId);
  for (const id of path) {
    rootById.set(id, rootId);
  }
  return rootId;
}

export function resolveReviewThreadRootId(
  comments: readonly ReviewCommentGraphNode[],
  commentId: number,
): number | null {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const start = byId.get(commentId);
  if (!start) return null;
  return resolveCommentRootId(start, byId, rootById);
}

function groupCommentsByThreadRoot<T extends ReviewCommentGraphNode>(
  comments: readonly T[],
): { readonly rootId: number; readonly root: T; readonly comments: readonly T[] }[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const threads = new Map<number, T[]>();

  for (const comment of comments) {
    const rootId = resolveCommentRootId(comment, byId, rootById);
    const bucket = threads.get(rootId) ?? [];
    bucket.push(comment);
    threads.set(rootId, bucket);
  }

  const grouped: { readonly rootId: number; readonly root: T; readonly comments: readonly T[] }[] =
    [];
  for (const [rootId, threadComments] of threads) {
    const root =
      threadComments.find((comment) => comment.inReplyToId == null) ??
      threadComments.toSorted((a, b) => a.id - b.id)[0];
    if (!root) continue;
    grouped.push({ rootId, root, comments: threadComments });
  }
  return grouped;
}

export function truncatePriorInlineText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function extractHumanReplies(
  comments: readonly Pick<
    ReviewThreadComment,
    "userId" | "authorAssociation" | "authorType" | "body"
  >[],
  botUserId: number,
  maxChars: number = MAX_PRIOR_INLINE_REPLY_CHARS,
): ReviewThreadReply[] {
  return comments
    .filter((comment) => comment.userId !== botUserId)
    .map((comment) => ({
      body: truncatePriorInlineText(comment.body, maxChars),
      userId: comment.userId,
      authorAssociation: comment.authorAssociation ?? null,
      ...(comment.authorType != null ? { authorType: comment.authorType } : {}),
    }));
}

function extractBotTitleSnippet(body: string): string {
  const boldMatch = /\*\*(P[0-3])\*\*\s*·\s*\*\*([^*]+)\*\*/.exec(body);
  if (boldMatch) return `${boldMatch[1]} · ${boldMatch[2].trim()}`;
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return truncatePriorInlineText(firstLine ?? "Inline finding", 120);
}

function extractBotSeverity(body: string): BotFindingThread["severity"] {
  const match = /\bP([0-3])\b/.exec(body);
  if (!match) return null;
  switch (match[1]) {
    case "0":
      return "P0";
    case "1":
      return "P1";
    case "2":
      return "P2";
    case "3":
      return "P3";
    default:
      return null;
  }
}

function findVerificationStubCommentId(
  threadComments: readonly ReviewThreadComment[],
  botUserId: number,
  threadRootCommentId: number,
): number | undefined {
  const botReplies = threadComments
    .filter((comment) => comment.id !== threadRootCommentId && comment.userId === botUserId)
    .toSorted((a, b) => a.id - b.id);
  const newestFirst = botReplies.toReversed();
  const marked = newestFirst.find((comment) => comment.body.includes(VERIFICATION_STUB_MARKER));
  if (marked) return marked.id;
  const legacy = newestFirst.find((comment) =>
    comment.body.trimStart().startsWith("**Verification**:"),
  );
  return legacy?.id;
}

export function assembleBotReviewThreads(
  comments: readonly ReviewThreadComment[],
  params: {
    readonly botUserId: number;
    readonly reviewLenses: ReadonlyMap<number, AnyReviewLens>;
    readonly allowedLenses: ReadonlySet<AnyReviewLens>;
    readonly maintainerDecisionAssociations?: ReadonlySet<string>;
  },
): AssembledBotReviewThread[] {
  const assembled: AssembledBotReviewThread[] = [];
  const maintainerDecisionAssociations =
    params.maintainerDecisionAssociations ?? DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET;
  for (const group of groupCommentsByThreadRoot(comments)) {
    const root = group.root;
    if (root.userId !== params.botUserId || root.path == null) continue;
    if (root.pullRequestReviewId == null) continue;
    const lens = params.reviewLenses.get(root.pullRequestReviewId);
    if (!lens || !params.allowedLenses.has(lens)) continue;

    const replies = extractHumanReplies(group.comments, params.botUserId);
    const authorizedReplies: string[] = [];
    const untrustedReplies: string[] = [];
    for (const reply of replies) {
      const isAuthorized = isAuthorizedMaintainerDecision({
        userId: reply.userId,
        botUserId: params.botUserId,
        authorAssociation: reply.authorAssociation,
        authorType: reply.authorType,
        allowedAssociations: maintainerDecisionAssociations,
      });
      (isAuthorized ? authorizedReplies : untrustedReplies).push(reply.body);
    }

    assembled.push({
      rootCommentId: root.id,
      lens,
      path: root.path,
      line: root.line ?? root.originalLine ?? 1,
      rootBody: root.body,
      htmlUrl: root.htmlUrl,
      comments: group.comments,
      humanReplies: replies.map((reply) => reply.body),
      authorizedReplies,
      untrustedReplies,
      replies,
    });
  }
  return assembled;
}

export function mapAssembledThreadsToPriorInlineFeedback(
  threads: readonly AssembledBotReviewThread[],
): PriorInlineFeedbackThread[] {
  return threads
    .filter((thread) => thread.humanReplies.length > 0)
    .map((thread) => ({
      path: thread.path,
      startLine: thread.line,
      endLine: thread.line,
      botTitleSnippet: extractBotTitleSnippet(thread.rootBody),
      humanReplies: [...thread.humanReplies],
      authorizedReplies: [...thread.authorizedReplies],
      untrustedReplies: [...thread.untrustedReplies],
      replies: [...thread.replies],
      threadUrl: thread.htmlUrl,
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
    .slice(0, MAX_PRIOR_INLINE_FEEDBACK_THREADS);
}

export function selectFindingObjections(
  thread: Pick<AssembledBotReviewThread, "rootCommentId" | "comments">,
  params: {
    readonly botUserId: number;
    readonly botLogin: string;
    readonly allowedAssociations: ReadonlySet<string>;
  },
): FindingObjection[] {
  const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
  const anchor = root?.createdAt;
  if (!isUsableReviewTimestamp(anchor)) return [];
  const objections: FindingObjection[] = [];
  for (const comment of thread.comments) {
    if (comment.id === thread.rootCommentId) continue;
    if (comment.authorType !== "User") continue;
    if (typeof comment.userId !== "number" || comment.userId === params.botUserId) continue;
    const createdAt = comment.createdAt;
    const updatedAt = comment.updatedAt;
    if (!isUsableReviewTimestamp(createdAt) || !isUsableReviewTimestamp(updatedAt)) continue;
    if (!isStrictlyAfter(createdAt, anchor) && !isStrictlyAfter(updatedAt, anchor)) continue;
    const answered = thread.comments.some(
      (reply) =>
        isBotAuthor(reply.authorLogin ?? null, params.botLogin) &&
        commentCarriesObjectionAnswer(reply.body, comment.id, updatedAt),
    );
    if (answered) continue;
    objections.push({
      commentId: comment.id,
      createdAt,
      updatedAt,
      authorUserId: comment.userId,
      association: comment.authorAssociation ?? null,
      authorized: isAuthorizedMaintainerDecision({
        userId: comment.userId,
        botUserId: params.botUserId,
        authorAssociation: comment.authorAssociation,
        authorType: comment.authorType,
        allowedAssociations: params.allowedAssociations,
      }),
      body: truncatePriorInlineText(comment.body, MAX_PRIOR_INLINE_REPLY_CHARS),
    });
  }
  return objections;
}

function isStrictlyAfter(value: string, anchor: string): boolean {
  return Date.parse(value) > Date.parse(anchor);
}

export function mapAssembledThreadsToBotFindings(
  threads: readonly AssembledBotReviewThread[],
  botUserId: number,
  selection?: {
    readonly botLogin?: string;
    readonly maintainerDecisionAssociations?: ReadonlySet<string>;
  },
): BotFindingThread[] {
  const allowedAssociations =
    selection?.maintainerDecisionAssociations ?? DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET;
  const botLogin = selection?.botLogin ?? "";
  return threads
    .map((thread) => {
      const hasTriageReply = thread.comments.some(
        (comment) =>
          comment.id !== thread.rootCommentId &&
          comment.userId === botUserId &&
          comment.body.trimStart().startsWith("**Triage**:"),
      );
      const verificationStubCommentId = findVerificationStubCommentId(
        thread.comments,
        botUserId,
        thread.rootCommentId,
      );
      const objections = selectFindingObjections(thread, {
        botUserId,
        botLogin,
        allowedAssociations,
      });
      return {
        rootCommentId: thread.rootCommentId,
        ...(thread.findingId != null ? { findingId: thread.findingId } : {}),
        lens: thread.lens,
        path: thread.path,
        line: thread.line,
        severity: extractBotSeverity(thread.rootBody),
        titleSnippet: extractBotTitleSnippet(thread.rootBody),
        humanReplies: [...thread.humanReplies],
        authorizedReplies: [...thread.authorizedReplies],
        untrustedReplies: [...thread.untrustedReplies],
        replies: [...thread.replies],
        hasTriageReply,
        ...(verificationStubCommentId != null ? { verificationStubCommentId } : {}),
        ...(objections.length > 0
          ? {
              objections,
              findingExcerpt: truncatePriorInlineText(
                thread.rootBody,
                MAX_PRIOR_INLINE_REPLY_CHARS,
              ),
            }
          : {}),
        threadUrl: thread.htmlUrl,
      };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

async function assembleBotThreadsForPullRequest(
  prSurface: PrSurface,
  params: {
    readonly botUserId: number;
    readonly allowedLenses: ReadonlySet<AnyReviewLens>;
    readonly publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>;
    readonly maintainerDecisionAssociations: ReadonlySet<string>;
  },
): Promise<{
  readonly threads: AssembledBotReviewThread[];
  readonly reviewCommentsTruncated: boolean;
}> {
  const [reviews, listed] = await Promise.all([
    prSurface.listPullRequestReviews(),
    prSurface.listReviewComments(),
  ]);
  const reviewLenses = new Map<number, AnyReviewLens>();
  for (const review of reviews) {
    if (review.userId !== params.botUserId) continue;
    const lens = resolveReviewLensFromPointerOrRecords(
      review.body ?? "",
      review.id,
      params.publishRecordLenses,
    );
    if (lens && isAnyReviewLens(lens)) reviewLenses.set(review.id, lens);
  }
  if (reviewLenses.size === 0) {
    return { threads: [], reviewCommentsTruncated: listed.truncated };
  }
  return {
    threads: assembleBotReviewThreads(listed.comments, {
      botUserId: params.botUserId,
      reviewLenses,
      allowedLenses: params.allowedLenses,
      maintainerDecisionAssociations: params.maintainerDecisionAssociations,
    }),
    reviewCommentsTruncated: listed.truncated,
  };
}

function selectInventoryFindingThreads(
  threads: readonly AssembledBotReviewThread[],
  inventory: FindingInventory,
): AssembledBotReviewThread[] {
  const findingByRootCommentId = new Map<number, InventoryFinding>();
  for (const finding of [...inventory.findings.values(), ...inventory.sameIdCopies]) {
    if (finding.rootCommentId != null) findingByRootCommentId.set(finding.rootCommentId, finding);
  }
  const inventoryComplete = inventory.completeness === "complete";
  return threads.flatMap((thread) => {
    const finding = findingByRootCommentId.get(thread.rootCommentId);
    if (finding == null) return inventoryComplete ? [] : [thread];
    return [
      {
        ...thread,
        line: finding.line ?? thread.line,
        ...(inventoryComplete ? { findingId: finding.id } : {}),
      },
    ];
  });
}

export async function fetchPriorInlineFeedback(
  prSurface: PrSurface,
  params: {
    readonly botUserId: number;
    readonly currentLens: AnyReviewLens;
    readonly maintainerDecisionAssociations?: ReadonlySet<string>;
  },
): Promise<PriorInlineFeedbackThread[]> {
  const [assembled, inventory] = await Promise.all([
    assembleBotThreadsForPullRequest(prSurface, {
      botUserId: params.botUserId,
      allowedLenses: priorFeedbackLensesForSelection(params.currentLens),
      maintainerDecisionAssociations:
        params.maintainerDecisionAssociations ?? DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET,
    }),
    loadFindingInventory(prSurface, { renames: new Map(), deletedPaths: new Set() }).catch(() =>
      unavailableFindingInventory({ renames: new Map(), deletedPaths: new Set() }),
    ),
  ]);
  return mapAssembledThreadsToPriorInlineFeedback(
    selectInventoryFindingThreads(assembled.threads, inventory),
  );
}

export async function fetchBotFindingThreads(
  prSurface: PrSurface,
  params: {
    readonly botUserId: number;
    readonly botLogin?: string;
    readonly inventory: FindingInventory;
    readonly publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>;
    readonly maintainerDecisionAssociations?: ReadonlySet<string>;
  },
): Promise<{
  readonly threads: BotFindingThread[];
  readonly reviewCommentsTruncated: boolean;
}> {
  const maintainerDecisionAssociations =
    params.maintainerDecisionAssociations ?? DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET;
  const assembled = await assembleBotThreadsForPullRequest(prSurface, {
    botUserId: params.botUserId,
    allowedLenses: priorFeedbackLensesForSelection("review"),
    publishRecordLenses: params.publishRecordLenses,
    maintainerDecisionAssociations,
  });
  return {
    threads: mapAssembledThreadsToBotFindings(
      selectInventoryFindingThreads(assembled.threads, params.inventory),
      params.botUserId,
      {
        botLogin: params.botLogin,
        maintainerDecisionAssociations,
      },
    ),
    reviewCommentsTruncated: assembled.reviewCommentsTruncated,
  };
}

export function hasAuthorizedMaintainerDecision(
  thread: Pick<BotFindingThread, "authorizedReplies">,
): boolean {
  return (thread.authorizedReplies?.length ?? 0) > 0;
}

function isAuthorizedMaintainerDecision(params: {
  readonly userId: number | null | undefined;
  readonly botUserId: number;
  readonly authorAssociation: string | null | undefined;
  readonly authorType: string | null | undefined;
  readonly allowedAssociations: ReadonlySet<string>;
}): boolean {
  if (params.authorType !== "User") return false;
  if (params.userId == null || params.userId === params.botUserId) return false;
  const association = params.authorAssociation?.trim().toUpperCase();
  if (!association || association === "*") return false;
  return params.allowedAssociations.has(association);
}
