import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  MAX_PRIOR_INLINE_FEEDBACK_THREADS,
  MAX_PRIOR_INLINE_REPLY_CHARS,
  REVIEW_POINTER_BODY,
  QUALITY_REVIEW_POINTER_BODY,
  SECURITY_REVIEW_POINTER_BODY,
  TESTS_REVIEW_POINTER_BODY,
} from "../settings.js";
import { installationOctokit } from "../github/appAuth.js";
import { escapeTablePlainCell } from "../github/markdownFormat.js";
import type { ReviewMode } from "./reviewSchema.js";

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
  lens: ReviewMode;
  path: string;
  line: number;
  severity: "P0" | "P1" | "P2" | "P3" | null;
  titleSnippet: string;
  humanReplies: string[];
  hasTriageReply?: boolean;
  threadUrl: string;
};

type ReviewCommentRow = {
  id: number;
  inReplyToId: number | null;
  pullRequestReviewId: number | null;
  userId: number | null;
  body: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  htmlUrl: string;
};

const TRIAGE_REVIEW_MODES = [
  "review",
  "review-security",
  "review-quality",
  "review-tests",
] as const satisfies readonly ReviewMode[];

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function extractBotTitleSnippet(body: string): string {
  const boldMatch = /\*\*(P[0-3])\*\*\s*·\s*\*\*([^*]+)\*\*/.exec(body);
  if (boldMatch) return `${boldMatch[1]} · ${boldMatch[2].trim()}`;
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return truncateText(firstLine ?? "Inline finding", 120);
}

function extractBotSeverity(body: string): BotFindingThread["severity"] {
  const match = /\bP([0-3])\b/.exec(body);
  return match ? (`P${match[1]}` as BotFindingThread["severity"]) : null;
}

const REVIEW_POINTER_LENS_MARKER_RE = /<!--\s*pr-agent:review-pointer\s+lens=([^\s>]+)\s*-->/;

export function parseReviewPointerLensMarker(body: string): ReviewMode | null {
  const match = REVIEW_POINTER_LENS_MARKER_RE.exec(body);
  if (!match) return null;
  const lens = match[1];
  return (TRIAGE_REVIEW_MODES as readonly string[]).includes(lens) ? (lens as ReviewMode) : null;
}

export function classifyReviewLensFromPointerBody(body: string): ReviewMode | null {
  const markerLens = parseReviewPointerLensMarker(body);
  if (markerLens) return markerLens;
  if (body.includes(SECURITY_REVIEW_POINTER_BODY)) return "review-security";
  if (body.includes(QUALITY_REVIEW_POINTER_BODY)) return "review-quality";
  if (body.includes(TESTS_REVIEW_POINTER_BODY)) return "review-tests";
  if (body.includes(REVIEW_POINTER_BODY)) return "review";
  return null;
}

function resolveReviewLensForTriage(
  body: string,
  reviewId: number,
  publishRecordLenses?: ReadonlyMap<number, ReviewMode>,
): ReviewMode | null {
  const fromBody = classifyReviewLensFromPointerBody(body);
  if (fromBody) return fromBody;
  const fromRecords = publishRecordLenses?.get(reviewId);
  return fromRecords ?? null;
}

export function resolveReviewThreadRootId(
  comments: readonly Pick<ReviewCommentRow, "id" | "inReplyToId">[],
  commentId: number,
): number | null {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const start = byId.get(commentId);
  if (!start) return null;
  return rootCommentId(start, byId, rootById);
}

async function paginatePullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewCommentRow[]> {
  const octokit = installationOctokit(token);
  let pageCount = 0;
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: COMMENTS_PAGE_SIZE,
    },
    (response, done) => {
      pageCount += 1;
      if (pageCount >= COMMENT_PAGINATION_MAX_PAGES) done();
      return response.data;
    },
  );

  return comments.map((comment) => ({
    id: comment.id,
    inReplyToId: comment.in_reply_to_id ?? null,
    pullRequestReviewId: comment.pull_request_review_id ?? null,
    userId: comment.user?.id ?? null,
    body: comment.body ?? "",
    path: comment.path ?? null,
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    htmlUrl: comment.html_url,
  }));
}

export async function fetchReviewCommentParentGraph(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<readonly Pick<ReviewCommentRow, "id" | "inReplyToId">[]> {
  const comments = await paginatePullRequestReviewComments(token, owner, repo, pullNumber);
  return comments.map((comment) => ({ id: comment.id, inReplyToId: comment.inReplyToId }));
}

type BotReviewLensIndex =
  | { kind: "lens"; mode: ReviewMode }
  | { kind: "triage"; publishRecordLenses?: ReadonlyMap<number, ReviewMode> };

async function listBotReviewIds(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  index: BotReviewLensIndex,
): Promise<Map<number, ReviewMode>> {
  const octokit = installationOctokit(token);
  let pageCount = 0;
  const reviews = await octokit.paginate(
    octokit.rest.pulls.listReviews,
    {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: COMMENTS_PAGE_SIZE,
    },
    (response, done) => {
      pageCount += 1;
      if (pageCount >= COMMENT_PAGINATION_MAX_PAGES) done();
      return response.data;
    },
  );

  const reviewIds = new Map<number, ReviewMode>();
  for (const review of reviews) {
    if (review.user?.id !== botUserId || review.id == null) continue;
    const lens =
      index.kind === "lens"
        ? classifyReviewLensFromPointerBody(review.body ?? "")
        : resolveReviewLensForTriage(review.body ?? "", review.id, index.publishRecordLenses);
    if (!lens) continue;
    if (index.kind === "lens" && lens !== index.mode) continue;
    reviewIds.set(review.id, lens);
  }
  return reviewIds;
}

function rootCommentId(
  comment: Pick<ReviewCommentRow, "id" | "inReplyToId">,
  byId: Map<number, Pick<ReviewCommentRow, "id" | "inReplyToId">>,
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

function groupThreadsByRoot(
  comments: readonly ReviewCommentRow[],
): Map<number, ReviewCommentRow[]> {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const threads = new Map<number, ReviewCommentRow[]>();

  for (const comment of comments) {
    const rootId = rootCommentId(comment, byId, rootById);
    const bucket = threads.get(rootId) ?? [];
    bucket.push(comment);
    threads.set(rootId, bucket);
  }

  return threads;
}

export async function fetchPriorInlineReviewFeedback(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  mode: ReviewMode,
  botUserId: number,
): Promise<PriorInlineFeedbackThread[]> {
  const [reviewIds, comments] = await Promise.all([
    listBotReviewIds(token, owner, repo, pullNumber, botUserId, { kind: "lens", mode }),
    paginatePullRequestReviewComments(token, owner, repo, pullNumber),
  ]);
  if (reviewIds.size === 0) return [];

  const threads = groupThreadsByRoot(comments);
  const results: PriorInlineFeedbackThread[] = [];
  for (const threadComments of threads.values()) {
    const root =
      threadComments.find((comment) => comment.inReplyToId == null) ??
      threadComments.toSorted((a, b) => a.id - b.id)[0];
    if (!root || root.userId !== botUserId || root.path == null) continue;
    if (root.pullRequestReviewId == null || !reviewIds.has(root.pullRequestReviewId)) continue;

    const humanReplies = threadComments
      .filter((comment) => comment.userId != null && comment.userId !== botUserId)
      .map((comment) => truncateText(comment.body, MAX_PRIOR_INLINE_REPLY_CHARS));
    if (humanReplies.length === 0) continue;

    const line = root.line ?? root.originalLine ?? 1;
    results.push({
      path: root.path,
      startLine: line,
      endLine: line,
      botTitleSnippet: extractBotTitleSnippet(root.body),
      humanReplies,
      threadUrl: root.htmlUrl,
    });
  }

  return results
    .toSorted((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
    .slice(0, MAX_PRIOR_INLINE_FEEDBACK_THREADS);
}

export async function fetchBotFindingThreads(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  publishRecordLenses?: ReadonlyMap<number, ReviewMode>,
): Promise<BotFindingThread[]> {
  const [comments, reviewIds] = await Promise.all([
    paginatePullRequestReviewComments(token, owner, repo, pullNumber),
    listBotReviewIds(token, owner, repo, pullNumber, botUserId, {
      kind: "triage",
      publishRecordLenses,
    }),
  ]);
  if (reviewIds.size === 0) return [];

  const threads = groupThreadsByRoot(comments);
  const results: BotFindingThread[] = [];
  for (const threadComments of threads.values()) {
    const root =
      threadComments.find((comment) => comment.inReplyToId == null) ??
      threadComments.toSorted((a, b) => a.id - b.id)[0];
    if (!root || root.userId !== botUserId || root.path == null) continue;
    if (root.pullRequestReviewId == null) continue;
    const lens = reviewIds.get(root.pullRequestReviewId);
    if (!lens) continue;

    const humanReplies = threadComments
      .filter((comment) => comment.userId != null && comment.userId !== botUserId)
      .map((comment) => truncateText(comment.body, MAX_PRIOR_INLINE_REPLY_CHARS));
    const hasTriageReply = threadComments.some(
      (comment) =>
        comment.id !== root.id &&
        comment.userId === botUserId &&
        comment.body.trimStart().startsWith("**Triage**:"),
    );
    const line = root.line ?? root.originalLine ?? 1;
    results.push({
      rootCommentId: root.id,
      lens,
      path: root.path,
      line,
      severity: extractBotSeverity(root.body),
      titleSnippet: extractBotTitleSnippet(root.body),
      humanReplies,
      hasTriageReply,
      threadUrl: root.htmlUrl,
    });
  }

  return results.toSorted((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
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
