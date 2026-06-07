import { COMMENT_PAGINATION_MAX_PAGES, COMMENTS_PAGE_SIZE } from "../settings/index.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPages } from "./paginateOctokit.js";

export type PullRequestReviewCommentThreadRow = {
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly pullRequestReviewId: number | null;
  readonly userId: number | null;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly htmlUrl: string;
};

type ReviewCommentParentLink = Pick<PullRequestReviewCommentThreadRow, "id" | "inReplyToId">;

export async function listPullRequestReviewCommentThreadRows(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestReviewCommentThreadRow[]> {
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

export function rootReviewCommentId(
  comment: ReviewCommentParentLink,
  byId: ReadonlyMap<number, ReviewCommentParentLink>,
): number {
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

export async function findPullRequestReviewCommentThreadRootId(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
): Promise<number> {
  const comments = await listPullRequestReviewCommentThreadRows(token, owner, repo, pullNumber);
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const comment = byId.get(commentId);
  return comment ? rootReviewCommentId(comment, byId) : commentId;
}
