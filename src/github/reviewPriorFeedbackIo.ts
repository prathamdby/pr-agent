import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET,
} from "../settings/index.js";
import { isAnyReviewLens, type AnyReviewLens } from "../settings/legacyReviewLenses.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPages } from "./paginateOctokit.js";
import {
  assembleBotReviewThreads,
  mapAssembledThreadsToBotFindings,
  mapAssembledThreadsToPriorInlineFeedback,
  priorFeedbackLensesForSelection,
  resolveReviewLensFromPointerOrRecords,
  type BotFindingThread,
  type PriorInlineFeedbackThread,
  type ReviewThreadComment,
} from "../review/run/reviewPriorFeedback.js";

async function listPullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  expiresAtTs?: number,
): Promise<ReviewThreadComment[]> {
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
    authorAssociation: comment.author_association ?? null,
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
): Promise<readonly Pick<ReviewThreadComment, "id" | "inReplyToId">[]> {
  const comments = await listPullRequestReviewComments(token, owner, repo, pullNumber, expiresAtTs);
  return comments.map((comment) => ({ id: comment.id, inReplyToId: comment.inReplyToId }));
}

async function listBotReviewLenses(
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
    const lens = resolveReviewLensFromPointerOrRecords(
      review.body ?? "",
      review.id,
      publishRecordLenses,
    );
    if (lens && isAnyReviewLens(lens)) {
      reviewIds.set(review.id, lens);
    }
  }
  return reviewIds;
}

async function assembleBotThreadsForPullRequest(params: {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly botUserId: number;
  readonly allowedLenses: ReturnType<typeof priorFeedbackLensesForSelection>;
  readonly publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>;
  readonly expiresAtTs?: number;
  readonly maintainerDecisionAssociations: ReadonlySet<string>;
}) {
  const [reviewLenses, comments] = await Promise.all([
    listBotReviewLenses(
      params.token,
      params.owner,
      params.repo,
      params.pullNumber,
      params.botUserId,
      params.publishRecordLenses,
      params.expiresAtTs,
    ),
    listPullRequestReviewComments(
      params.token,
      params.owner,
      params.repo,
      params.pullNumber,
      params.expiresAtTs,
    ),
  ]);
  if (reviewLenses.size === 0) return [];
  return assembleBotReviewThreads(comments, {
    botUserId: params.botUserId,
    reviewLenses,
    allowedLenses: params.allowedLenses,
    maintainerDecisionAssociations: params.maintainerDecisionAssociations,
  });
}

export async function fetchPriorInlineReviewFeedback(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  currentLens: AnyReviewLens,
  expiresAtTs?: number,
  maintainerDecisionAssociations: ReadonlySet<string> = DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET,
): Promise<PriorInlineFeedbackThread[]> {
  return mapAssembledThreadsToPriorInlineFeedback(
    await assembleBotThreadsForPullRequest({
      token,
      owner,
      repo,
      pullNumber,
      botUserId,
      allowedLenses: priorFeedbackLensesForSelection(currentLens),
      expiresAtTs,
      maintainerDecisionAssociations,
    }),
  );
}

export async function fetchBotFindingThreads(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  botUserId: number,
  publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>,
  expiresAtTs?: number,
  maintainerDecisionAssociations: ReadonlySet<string> = DEFAULT_MAINTAINER_DECISION_ASSOCIATION_SET,
): Promise<BotFindingThread[]> {
  return mapAssembledThreadsToBotFindings(
    await assembleBotThreadsForPullRequest({
      token,
      owner,
      repo,
      pullNumber,
      botUserId,
      allowedLenses: priorFeedbackLensesForSelection("review"),
      publishRecordLenses,
      expiresAtTs,
      maintainerDecisionAssociations,
    }),
    botUserId,
  );
}
