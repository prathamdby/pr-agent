import {
  MAX_PRIOR_INLINE_FEEDBACK_THREADS,
  MAX_PRIOR_INLINE_REPLY_CHARS,
  REVIEW_POINTER_BODY,
  VERIFICATION_STUB_MARKER,
} from "../../settings/index.js";
import { escapeTablePlainCell } from "../../github/markdownFormat.js";
import {
  LEGACY_REVIEW_LENSES,
  LEGACY_REVIEW_POINTER_BODIES,
  isAnyReviewLens,
  type AnyReviewLens,
} from "../../settings/legacyReviewLenses.js";

export type PriorInlineFeedbackThread = {
  path: string;
  startLine: number;
  endLine: number;
  botTitleSnippet: string;
  humanReplies: string[];
  threadUrl: string;
};

export type BotFindingThread = {
  rootCommentId: number;
  lens: AnyReviewLens;
  path: string;
  line: number;
  severity: "P0" | "P1" | "P2" | "P3" | null;
  titleSnippet: string;
  humanReplies: string[];
  hasTriageReply?: boolean;
  /** Bot reply id for the verification stub when one already exists on the thread. */
  verificationStubCommentId?: number;
  threadUrl: string;
};

export type ReviewCommentGraphNode = {
  readonly id: number;
  readonly inReplyToId: number | null;
};

export type ReviewThreadComment = ReviewCommentGraphNode & {
  readonly pullRequestReviewId: number | null;
  readonly userId: number | null;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly htmlUrl: string;
};

export type AssembledBotReviewThread = {
  readonly rootCommentId: number;
  readonly lens: AnyReviewLens;
  readonly path: string;
  readonly line: number;
  readonly rootBody: string;
  readonly htmlUrl: string;
  readonly comments: readonly ReviewThreadComment[];
  readonly humanReplies: readonly string[];
};

/**
 * Normalized `review` includes the current lens plus every recognized legacy
 * lens. Exact legacy selection stays exact so a mismatch can be asserted.
 */
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

export function resolveReviewLensFromPointerOrRecords(
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

function extractHumanReplyBodies(
  comments: readonly Pick<ReviewThreadComment, "userId" | "body">[],
  botUserId: number,
  maxChars: number = MAX_PRIOR_INLINE_REPLY_CHARS,
): string[] {
  return comments
    .filter((comment) => comment.userId != null && comment.userId !== botUserId)
    .map((comment) => truncatePriorInlineText(comment.body, maxChars));
}

function extractBotTitleSnippet(body: string): string {
  const boldMatch = /\*\*(P[0-3])\*\*\s*·\s*\*\*([^*]+)\*\*/.exec(body);
  if (boldMatch) return `${boldMatch[1]} · ${boldMatch[2].trim()}`;
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return truncatePriorInlineText(firstLine ?? "Inline finding", 120);
}

function extractBotSeverity(body: string): BotFindingThread["severity"] {
  const match = /\bP([0-3])\b/.exec(body);
  return match ? (`P${match[1]}` as BotFindingThread["severity"]) : null;
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

/**
 * Shared lens-aware assembly: resolve nested roots, group replies, extract
 * human replies, and drop threads whose lens is outside the selection set.
 */
export function assembleBotReviewThreads(
  comments: readonly ReviewThreadComment[],
  params: {
    readonly botUserId: number;
    readonly reviewLenses: ReadonlyMap<number, AnyReviewLens>;
    readonly allowedLenses: ReadonlySet<AnyReviewLens>;
  },
): AssembledBotReviewThread[] {
  const assembled: AssembledBotReviewThread[] = [];
  for (const group of groupCommentsByThreadRoot(comments)) {
    const root = group.root;
    if (root.userId !== params.botUserId || root.path == null) continue;
    if (root.pullRequestReviewId == null) continue;
    const lens = params.reviewLenses.get(root.pullRequestReviewId);
    if (!lens || !params.allowedLenses.has(lens)) continue;

    assembled.push({
      rootCommentId: root.id,
      lens,
      path: root.path,
      line: root.line ?? root.originalLine ?? 1,
      rootBody: root.body,
      htmlUrl: root.htmlUrl,
      comments: group.comments,
      humanReplies: extractHumanReplyBodies(group.comments, params.botUserId),
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
      threadUrl: thread.htmlUrl,
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
    .slice(0, MAX_PRIOR_INLINE_FEEDBACK_THREADS);
}

export function mapAssembledThreadsToBotFindings(
  threads: readonly AssembledBotReviewThread[],
  botUserId: number,
): BotFindingThread[] {
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
      return {
        rootCommentId: thread.rootCommentId,
        lens: thread.lens,
        path: thread.path,
        line: thread.line,
        severity: extractBotSeverity(thread.rootBody),
        titleSnippet: extractBotTitleSnippet(thread.rootBody),
        humanReplies: [...thread.humanReplies],
        hasTriageReply,
        ...(verificationStubCommentId != null ? { verificationStubCommentId } : {}),
        threadUrl: thread.htmlUrl,
      };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function formatPriorInlineFeedbackBlock(
  threads: readonly PriorInlineFeedbackThread[],
): string {
  if (threads.length === 0) return "";

  const lines = [
    "## Prior inline review feedback (trusted context)",
    "Maintainer replies on earlier bot inline threads for this review lens. Treat explicit dismissals (false positive, intentional, already fixed) as closed unless new commits materially change the code at that location.",
    "",
  ];

  for (const thread of threads) {
    lines.push(
      `- \`${escapeTablePlainCell(thread.path)}\` L${thread.startLine} · ${escapeTablePlainCell(thread.botTitleSnippet)}`,
    );
    for (const reply of thread.humanReplies) {
      lines.push(`  - Maintainer reply (user-provided): ${escapeTablePlainCell(reply)}`);
    }
    lines.push(`  - Thread: ${escapeTablePlainCell(thread.threadUrl)}`);
  }

  return lines.join("\n");
}
