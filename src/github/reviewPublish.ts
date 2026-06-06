import { installationOctokit } from "./appAuth.js";
import { httpStatus } from "./httpStatus.js";
import { REVIEW_SUMMARY_SENTINEL } from "../settings/index.js";

export type InlineReviewComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
};

import { COMMENTS_PAGE_SIZE, COMMENT_PAGINATION_MAX_PAGES } from "../settings/index.js";
import { paginateOctokitPages } from "./paginateOctokit.js";

export async function createPullRequestReviewWithComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  params: {
    body: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    comments?: InlineReviewComment[];
    commitId?: string;
  },
): Promise<{ id: number; url: string }> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body: params.body,
    event: params.event,
    comments: params.comments,
    commit_id: params.commitId,
  });
  return { id: data.id, url: data.html_url };
}

export type PublishedReviewComment = {
  path: string;
  line: number;
  id: number;
  url: string;
};

export async function listPullRequestReviewCommentsForReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
): Promise<PublishedReviewComment[]> {
  const octokit = installationOctokit(token);
  const comments = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listCommentsForReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: reviewId,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  const parsed = comments.flatMap((comment) => {
    if (comment.path == null || comment.line == null) return [];
    return [
      {
        path: comment.path,
        line: comment.line,
        id: comment.id,
        url: comment.html_url,
      },
    ];
  });
  return parsed.toSorted((a, b) => a.id - b.id);
}

export type IssueCommentRef = { id: number; url: string };
export type ResolvedSummaryCommentRef = IssueCommentRef & { source: "hint" | "scan" };

async function getIssueCommentIfSentinel(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  sentinel: string,
): Promise<IssueCommentRef | null> {
  const octokit = installationOctokit(token);
  try {
    const { data } = await octokit.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });
    if (!(data.body ?? "").startsWith(sentinel)) return null;
    return { id: data.id, url: data.html_url };
  } catch (e: unknown) {
    const status = httpStatus(e);
    if (status === 404) return null;
    throw e;
  }
}

export async function findIssueCommentBySentinel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  sentinel: string,
): Promise<IssueCommentRef | null> {
  const octokit = installationOctokit(token);
  let lastMatch: IssueCommentRef | null = null;

  const pages = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });

  for (const c of pages) {
    if ((c.body ?? "").startsWith(sentinel)) {
      lastMatch = { id: c.id, url: c.html_url };
    }
  }

  return lastMatch;
}

export async function resolveVerifiedSummaryCommentRef(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  sentinel: string,
  hintCommentId?: number | null,
): Promise<ResolvedSummaryCommentRef | null> {
  if (hintCommentId != null) {
    const verified = await getIssueCommentIfSentinel(token, owner, repo, hintCommentId, sentinel);
    if (verified) return { ...verified, source: "hint" };
  }
  const found = await findIssueCommentBySentinel(token, owner, repo, prNumber, sentinel);
  return found ? { ...found, source: "scan" } : null;
}

/** Resolves a verified summary/progress comment URL; never returns an unverified stored id. */
export async function resolveVerifiedSummaryCommentUrl(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  sentinel: string,
  hintCommentId?: number | null,
): Promise<string | undefined> {
  return (
    await resolveVerifiedSummaryCommentRef(token, owner, repo, prNumber, sentinel, hintCommentId)
  )?.url;
}

async function createIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; url: string }> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { id: data.id, url: data.html_url };
}

async function updateIssueComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = installationOctokit(token);
  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });
}

export async function upsertReviewSummaryComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  sentinel: string = REVIEW_SUMMARY_SENTINEL,
  knownExisting?: IssueCommentRef | null,
): Promise<{ id: number; updated: boolean }> {
  const existing =
    knownExisting ?? (await findIssueCommentBySentinel(token, owner, repo, prNumber, sentinel));
  if (existing) {
    await updateIssueComment(token, owner, repo, existing.id, body);
    return { id: existing.id, updated: true };
  }
  const created = await createIssueComment(token, owner, repo, prNumber, body);
  return { id: created.id, updated: false };
}

export async function listPullRequestLabels(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const octokit = installationOctokit(token);
  const { data } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: pullNumber,
  });
  return data.map((l) => l.name);
}

export async function setPullRequestLabels(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  labels: string[],
): Promise<void> {
  const octokit = installationOctokit(token);
  await octokit.rest.issues.setLabels({
    owner,
    repo,
    issue_number: pullNumber,
    labels,
  });
}
