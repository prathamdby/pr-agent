import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  MAX_PRIOR_INLINE_FEEDBACK_THREADS,
  MAX_PRIOR_INLINE_REPLY_CHARS,
  REVIEW_POINTER_BODY,
  QUALITY_REVIEW_POINTER_BODY,
  SECURITY_REVIEW_POINTER_BODY,
} from "../settings/index.js";
import { installationOctokit } from "../github/appAuth.js";
import { paginateOctokitPages } from "../github/paginateOctokit.js";
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

export function classifyReviewLensFromPointerBody(body: string): ReviewMode | null {
  if (body.includes(SECURITY_REVIEW_POINTER_BODY)) return "review-security";
  if (body.includes(QUALITY_REVIEW_POINTER_BODY)) return "review-quality";
  if (body.includes(REVIEW_POINTER_BODY)) return "review";
  return null;
}

async function listPullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewCommentRow[]> {
  const octokit = installationOctokit(token);
  const comments = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });

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

async function listBotReviewIdsForLens(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  mode: ReviewMode,
  botUserId: number,
): Promise<Set<number>> {
  const octokit = installationOctokit(token);
  const reviews = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });

  const reviewIds = new Set<number>();
  for (const review of reviews) {
    if (review.user?.id !== botUserId || review.id == null) continue;
    const lens = classifyReviewLensFromPointerBody(review.body ?? "");
    if (lens === mode) reviewIds.add(review.id);
  }
  return reviewIds;
}

function rootCommentId(comment: ReviewCommentRow, byId: Map<number, ReviewCommentRow>): number {
  let current = comment;
  const seen = new Set<number>();
  while (current.inReplyToId != null) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
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
    listBotReviewIdsForLens(token, owner, repo, pullNumber, mode, botUserId),
    listPullRequestReviewComments(token, owner, repo, pullNumber),
  ]);
  if (reviewIds.size === 0) return [];

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const threads = new Map<number, ReviewCommentRow[]>();

  for (const comment of comments) {
    const rootId = rootCommentId(comment, byId);
    const bucket = threads.get(rootId) ?? [];
    bucket.push(comment);
    threads.set(rootId, bucket);
  }

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
