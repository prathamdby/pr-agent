import { installationOctokit } from "./appAuth.js";
import { httpStatus } from "./httpStatus.js";
import { paginateOctokitPages, paginateOctokitPagesWithMeta } from "./paginateOctokit.js";
import {
  CHECK_RUNS_MAX_PAGES,
  CHECK_RUNS_PAGE_SIZE,
  COMMENTS_PAGE_SIZE,
  COMMENT_PAGINATION_MAX_PAGES,
  REVIEW_SUMMARY_SENTINEL,
} from "../settings/index.js";

export type InlineReviewComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
};

export type ReviewCheckRunConclusion = "success" | "failure" | "neutral" | "cancelled";

export async function findReviewCheckRunByName(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  externalId: string,
  expiresAtTs?: number,
): Promise<{ id: number; url: string | null } | null> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { items: runs, truncated } = await paginateOctokitPagesWithMeta({
    perPage: CHECK_RUNS_PAGE_SIZE,
    maxPages: CHECK_RUNS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: headSha,
        filter: "all",
        check_name: name,
        per_page: perPage,
        page,
      });
      return data.check_runs;
    },
  });
  if (truncated) return null;
  const matches = runs.filter(
    (check) =>
      check.name === name && check.head_sha === headSha && check.external_id === externalId,
  );
  if (matches.length !== 1) return null;
  const run = matches[0];
  return { id: run.id, url: run.html_url ?? null };
}

export async function createReviewCheckRun(
  token: string,
  owner: string,
  repo: string,
  params: {
    name: string;
    headSha: string;
    externalId: string;
    summary: string;
  },
  expiresAtTs?: number,
): Promise<{ id: number; url: string | null }> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { data } = await octokit.rest.checks.create({
    owner,
    repo,
    name: params.name,
    head_sha: params.headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    external_id: params.externalId,
    output: {
      title: params.name,
      summary: params.summary,
    },
  });
  return { id: data.id, url: data.html_url ?? null };
}

export async function updateReviewCheckRun(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  params: {
    name: string;
    conclusion: ReviewCheckRunConclusion;
    completedAt: string;
    summary: string;
    detailsUrl?: string;
  },
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    name: params.name,
    status: "completed",
    conclusion: params.conclusion,
    completed_at: params.completedAt,
    details_url: params.detailsUrl,
    output: {
      title: params.name,
      summary: params.summary,
    },
  });
}

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
  expiresAtTs?: number,
): Promise<{ id: number; url: string }> {
  const octokit = installationOctokit(token, expiresAtTs);
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

function parsePublishedReviewComments(
  comments: readonly { path?: string | null; line?: number | null; id: number; html_url: string }[],
): PublishedReviewComment[] {
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

export async function listPullRequestReviewCommentsForReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  expiresAtTs?: number,
): Promise<PublishedReviewComment[]> {
  const octokit = installationOctokit(token, expiresAtTs);
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
  return parsePublishedReviewComments(comments);
}

/**
 * Single PR-wide review-comment listing (bounded pages). Prefer this over
 * per-inline-review pagination when enriching summary placements.
 */
export async function listPullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  expiresAtTs?: number,
): Promise<{ readonly comments: PublishedReviewComment[]; readonly truncated: boolean }> {
  const octokit = installationOctokit(token, expiresAtTs);
  let stoppedAtCap = false;
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
      if (page >= COMMENT_PAGINATION_MAX_PAGES && data.length >= perPage) {
        stoppedAtCap = true;
      }
      return data;
    },
  });
  return {
    comments: parsePublishedReviewComments(comments),
    truncated: stoppedAtCap,
  };
}

export type IssueCommentRef = { id: number; url: string };
export type ResolvedSummaryCommentRef = IssueCommentRef & {
  source: "hint" | "scan";
};

export async function getIssueCommentIfSentinel(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  sentinel: string,
  expiresAtTs?: number,
): Promise<IssueCommentRef | null> {
  const octokit = installationOctokit(token, expiresAtTs);
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

export type IssueCommentWithBody = IssueCommentRef & { readonly body: string };

/** Latest issue comment whose body starts with `sentinel` (includes body text). */
export async function findIssueCommentBySentinel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  sentinel: string,
  expiresAtTs?: number,
): Promise<IssueCommentWithBody | null> {
  const octokit = installationOctokit(token, expiresAtTs);
  let lastMatch: IssueCommentWithBody | null = null;

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
    const body = c.body ?? "";
    if (body.startsWith(sentinel)) {
      lastMatch = { id: c.id, url: c.html_url, body };
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
  expiresAtTs?: number,
): Promise<ResolvedSummaryCommentRef | null> {
  if (hintCommentId != null) {
    const verified = await getIssueCommentIfSentinel(
      token,
      owner,
      repo,
      hintCommentId,
      sentinel,
      expiresAtTs,
    );
    if (verified) return { ...verified, source: "hint" };
  }
  const found = await findIssueCommentBySentinel(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    expiresAtTs,
  );
  return found ? { ...found, source: "scan" } : null;
}

async function createIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  expiresAtTs?: number,
): Promise<{ id: number; url: string }> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { id: data.id, url: data.html_url };
}

export async function updateIssueComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
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
  expiresAtTs?: number,
): Promise<{ id: number; updated: boolean }> {
  const existing =
    knownExisting ??
    (await findIssueCommentBySentinel(token, owner, repo, prNumber, sentinel, expiresAtTs));
  if (existing) {
    await updateIssueComment(token, owner, repo, existing.id, body, expiresAtTs);
    return { id: existing.id, updated: true };
  }
  const created = await createIssueComment(token, owner, repo, prNumber, body, expiresAtTs);
  return { id: created.id, updated: false };
}

export async function listPullRequestLabels(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  expiresAtTs?: number,
): Promise<string[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const labels = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.issues.listLabelsOnIssue({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return labels.map((l) => l.name);
}

export async function getPullRequestReviewComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  expiresAtTs?: number,
): Promise<{ pullRequestReviewId: number | null; userId: number }> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { data } = await octokit.rest.pulls.getReviewComment({
    owner,
    repo,
    comment_id: commentId,
  });
  return {
    pullRequestReviewId: data.pull_request_review_id ?? null,
    userId: data.user.id,
  };
}

export async function setPullRequestLabels(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  labels: string[],
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await octokit.rest.issues.setLabels({
    owner,
    repo,
    issue_number: pullNumber,
    labels,
  });
}

export async function setReviewCommitStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  params: {
    state: "success" | "failure" | "error";
    description: string;
    targetUrl?: string;
  },
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: params.state,
    context: "pr-agent/review",
    description: params.description,
    target_url: params.targetUrl,
  });
}
