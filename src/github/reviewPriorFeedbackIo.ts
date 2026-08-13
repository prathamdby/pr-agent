import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  MAX_PRIOR_INLINE_FEEDBACK_THREADS,
  MAX_PRIOR_INLINE_REPLY_CHARS,
  VERIFICATION_STUB_MARKER,
} from "../settings/index.js";
import { isAnyReviewLens, type AnyReviewLens } from "../settings/legacyReviewLenses.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPages } from "./paginateOctokit.js";
import {
  classifyReviewLensFromPointerBody,
  type BotFindingThread,
  type PriorInlineFeedbackThread,
} from "../review/run/reviewPriorFeedback.js";

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

const BOT_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

function isBotSeverity(value: string): value is NonNullable<BotFindingThread["severity"]> {
  return BOT_SEVERITIES.some((severity) => severity === value);
}

function extractBotSeverity(body: string): BotFindingThread["severity"] {
  const match = /\bP([0-3])\b/.exec(body);
  if (match == null) return null;
  const severity = `P${match[1]}`;
  return isBotSeverity(severity) ? severity : null;
}

function findVerificationStubCommentId(
  threadComments: readonly ReviewCommentRow[],
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

function resolveReviewLensForTriage(
  body: string,
  reviewId: number,
  publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>,
): AnyReviewLens | null {
  const fromBody = classifyReviewLensFromPointerBody(body);
  if (fromBody) return fromBody;
  const fromRecords = publishRecordLenses?.get(reviewId);
  return fromRecords ?? null;
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

async function listPullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  expiresAtTs?: number,
): Promise<ReviewCommentRow[]> {
  const octokit = installationOctokit(token, expiresAtTs);
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

export async function fetchReviewCommentParentGraph(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  expiresAtTs?: number,
): Promise<readonly Pick<ReviewCommentRow, "id" | "inReplyToId">[]> {
  const comments = await listPullRequestReviewComments(token, owner, repo, pullNumber, expiresAtTs);
  return comments.map((comment) => ({ id: comment.id, inReplyToId: comment.inReplyToId }));
}

async function listBotReviewIds(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  expiresAtTs?: number,
): Promise<Set<number>> {
  const octokit = installationOctokit(token, expiresAtTs);
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
    if (lens && isAnyReviewLens(lens)) reviewIds.add(review.id);
  }
  return reviewIds;
}

async function listBotReviewIdsForTriage(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  publishRecordLenses: ReadonlyMap<number, AnyReviewLens> | undefined,
  expiresAtTs?: number,
): Promise<Map<number, AnyReviewLens>> {
  const octokit = installationOctokit(token, expiresAtTs);
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

  const reviewIds = new Map<number, AnyReviewLens>();
  for (const review of reviews) {
    if (review.user?.id !== botUserId || review.id == null) continue;
    const lens = resolveReviewLensForTriage(review.body ?? "", review.id, publishRecordLenses);
    if (lens && isAnyReviewLens(lens)) {
      reviewIds.set(review.id, lens);
    }
  }
  return reviewIds;
}

export async function fetchPriorInlineReviewFeedback(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  expiresAtTs?: number,
): Promise<PriorInlineFeedbackThread[]> {
  const [reviewIds, comments] = await Promise.all([
    listBotReviewIds(token, owner, repo, pullNumber, botUserId, expiresAtTs),
    listPullRequestReviewComments(token, owner, repo, pullNumber, expiresAtTs),
  ]);
  if (reviewIds.size === 0) return [];

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const threads = new Map<number, ReviewCommentRow[]>();

  for (const comment of comments) {
    const rootId = rootCommentId(comment, byId, rootById);
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

export async function fetchBotFindingThreads(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>,
  expiresAtTs?: number,
): Promise<BotFindingThread[]> {
  const [comments, reviewIds] = await Promise.all([
    listPullRequestReviewComments(token, owner, repo, pullNumber, expiresAtTs),
    listBotReviewIdsForTriage(
      token,
      owner,
      repo,
      pullNumber,
      botUserId,
      publishRecordLenses,
      expiresAtTs,
    ),
  ]);
  if (reviewIds.size === 0) return [];

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootById = new Map<number, number>();
  const threads = new Map<number, ReviewCommentRow[]>();

  for (const comment of comments) {
    const rootId = rootCommentId(comment, byId, rootById);
    const bucket = threads.get(rootId) ?? [];
    bucket.push(comment);
    threads.set(rootId, bucket);
  }

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
    const verificationStubCommentId = findVerificationStubCommentId(
      threadComments,
      botUserId,
      root.id,
    );
    const line = root.line ?? root.originalLine ?? 1;
    const thread: BotFindingThread = {
      rootCommentId: root.id,
      lens,
      path: root.path,
      line,
      severity: extractBotSeverity(root.body),
      titleSnippet: extractBotTitleSnippet(root.body),
      humanReplies,
      hasTriageReply,
      threadUrl: root.htmlUrl,
    };
    if (verificationStubCommentId != null) {
      thread.verificationStubCommentId = verificationStubCommentId;
    }
    results.push(thread);
  }

  return results.toSorted((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
