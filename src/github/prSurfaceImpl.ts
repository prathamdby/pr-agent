import { getAppBotIdentity, installationOctokit } from "./appAuth.js";
import type { InstallationToken } from "./appAuth.js";
import { logDebug, logWarn } from "../evlog.js";
import { mintInstallationToken, isInstallationTokenNearExpiry } from "./installationToken.js";
import { downloadActionsJobLogs, listFailingActionsJobsForHead } from "./actionsLogs.js";
import { listCommitCompareFiles } from "./compareCommitFiles.js";
import {
  readCiStatusSources,
  listPullsForHead,
  listLegacyCommitStatusesForHeadDetailed,
} from "./ciStatus.js";
import { fetchPullRequestFiles, type PullRequestForFileList } from "./listPullRequestFiles.js";
import { isDuplicateCheckRunCreationError } from "./githubErrors.js";
import { httpStatus } from "./httpStatus.js";
import {
  createPullRequestReviewWithComments,
  createReviewCheckRun,
  findIssueCommentBySentinel,
  findReviewCheckRunByName,
  listPullRequestLabels,
  resolveVerifiedSummaryCommentRef,
  setPullRequestLabels,
  setReviewCommitStatus,
  updateIssueComment,
  updateReviewCheckRun,
  upsertReviewSummaryComment,
} from "./reviewPublish.js";
import { listReviewThreadResolution, resolveReviewThread } from "./reviewThreadResolution.js";
import { paginateOctokitPages } from "./paginateOctokit.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import type { ReplyTarget } from "../agentWork/types.js";
import {
  COMMENT_PAGINATION_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  PR_COMMITS_MAX_PAGES,
  PR_COMMITS_PAGE_SIZE,
  type GithubReactionContent,
} from "../settings/index.js";
import type {
  AcknowledgementTarget,
  CreatePrSurfaceParams,
  ListReviewCommentsResult,
  PrConversationComment,
  PrReview,
  PrSurface,
  ReviewCheckOutcome,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
import { errorMessage } from "../errors/errorMessage.js";
import { AppError } from "../errors/appError.js";
import {
  isConfirmedCapabilityDenial,
  type InstallationOperation,
} from "./installationCapabilities.js";

async function listConversationCommentsForPr(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<readonly PrConversationComment[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const rows = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return rows.map((comment) => ({
    id: comment.id,
    inReplyToId:
      "in_reply_to_id" in comment && typeof comment.in_reply_to_id === "number"
        ? comment.in_reply_to_id
        : null,
    authorLogin: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
  }));
}

async function listPushedCommitsForPr(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
) {
  const octokit = installationOctokit(token, expiresAtTs);
  const commits = await paginateOctokitPages({
    perPage: PR_COMMITS_PAGE_SIZE,
    maxPages: PR_COMMITS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return commits.map((commit) => ({
    sha: commit.sha,
    subject: commit.commit.message.split("\n")[0] ?? "",
  }));
}

async function listReviewCommentsForPr(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<ListReviewCommentsResult> {
  const octokit = installationOctokit(token, expiresAtTs);
  let stoppedAtCap = false;
  const rows = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
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
    comments: rows.map((comment) => ({
      id: comment.id,
      inReplyToId: comment.in_reply_to_id ?? null,
      pullRequestReviewId: comment.pull_request_review_id ?? null,
      userId: comment.user?.id ?? null,
      authorLogin: comment.user?.login ?? "unknown",
      authorAssociation: comment.author_association ?? null,
      body: comment.body ?? "",
      path: comment.path ?? null,
      line: comment.line ?? null,
      originalLine: comment.original_line ?? null,
      htmlUrl: comment.html_url,
    })),
    truncated: stoppedAtCap,
  };
}

async function listPullRequestReviewsForPr(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<readonly PrReview[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const reviews = await paginateOctokitPages({
    perPage: COMMENTS_PAGE_SIZE,
    maxPages: COMMENT_PAGINATION_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return reviews.map((review) => ({
    id: review.id,
    userId: review.user?.id ?? null,
    authorLogin: review.user?.login ?? null,
    body: review.body ?? null,
    commitId: review.commit_id ?? null,
    htmlUrl: review.html_url,
  }));
}

const REVIEW_CHECK_RUN_NAME = "PR Agent Review";

const LIFECYCLE_REACTIONS = new Set<string>([
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_PLUS_ONE,
  GITHUB_REACTION_MINUS_ONE,
]);

type ListedReaction = {
  readonly id: number;
  readonly content: string;
  readonly user: { readonly id: number } | null;
};

function reactionEndpoints(
  octokit: ReturnType<typeof installationOctokit>,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
) {
  if (target.kind === "pr") {
    return {
      create: (content: GithubReactionContent) =>
        octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: target.prNumber,
          content,
        }),
      list: () =>
        octokit.paginate(octokit.rest.reactions.listForIssue, {
          owner,
          repo,
          issue_number: target.prNumber,
          per_page: 100,
        }),
      delete: (reactionId: number) =>
        octokit.rest.reactions.deleteForIssue({
          owner,
          repo,
          issue_number: target.prNumber,
          reaction_id: reactionId,
        }),
    };
  }
  if (target.kind === "issueComment") {
    return {
      create: (content: GithubReactionContent) =>
        octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: target.commentId,
          content,
        }),
      list: () =>
        octokit.paginate(octokit.rest.reactions.listForIssueComment, {
          owner,
          repo,
          comment_id: target.commentId,
          per_page: 100,
        }),
      delete: (reactionId: number) =>
        octokit.rest.reactions.deleteForIssueComment({
          owner,
          repo,
          comment_id: target.commentId,
          reaction_id: reactionId,
        }),
    };
  }
  return {
    create: (content: GithubReactionContent) =>
      octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: target.commentId,
        content,
      }),
    list: () =>
      octokit.paginate(octokit.rest.reactions.listForPullRequestReviewComment, {
        owner,
        repo,
        comment_id: target.commentId,
        per_page: 100,
      }),
    delete: (reactionId: number) =>
      octokit.rest.reactions.deleteForPullRequestComment({
        owner,
        repo,
        comment_id: target.commentId,
        reaction_id: reactionId,
      }),
  };
}

async function safeReaction(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  content: GithubReactionContent = GITHUB_REACTION_EYES,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await reactionEndpoints(octokit, owner, repo, target).create(content);
}

async function listLifecycleReactions(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  expiresAtTs?: number,
): Promise<readonly ListedReaction[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  return reactionEndpoints(octokit, owner, repo, target).list();
}

async function deleteReaction(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  reactionId: number,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  await reactionEndpoints(octokit, owner, repo, target).delete(reactionId);
}

async function setLifecycleReaction(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  content: GithubReactionContent,
  botUserId: number | undefined,
  expiresAtTs?: number,
): Promise<void> {
  if (botUserId == null) {
    await safeReaction(token, owner, repo, target, content, expiresAtTs);
    return;
  }

  const existing = await listLifecycleReactions(token, owner, repo, target, expiresAtTs);
  const mine = existing.filter(
    (reaction) => reaction.user?.id === botUserId && LIFECYCLE_REACTIONS.has(reaction.content),
  );
  const hasDesired = mine.some((reaction) => reaction.content === content);
  await Promise.all(
    mine
      .filter((reaction) => reaction.content !== content)
      .map((reaction) => deleteReaction(token, owner, repo, target, reaction.id, expiresAtTs)),
  );
  if (!hasDesired) {
    await safeReaction(token, owner, repo, target, content, expiresAtTs);
  }
}

async function reactOnAckTargets(
  token: string,
  owner: string,
  repo: string,
  targets: readonly AcknowledgementTarget[],
  content: GithubReactionContent,
  botUserId: number | undefined,
  expiresAtTs?: number,
  strict = false,
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      try {
        await setLifecycleReaction(token, owner, repo, target, content, botUserId, expiresAtTs);
      } catch (e) {
        const status = httpStatus(e);
        if (status === 422) return;
        if (strict && isConfirmedCapabilityDenial(e)) throw e;
        if (status === 403) {
          logDebug("reaction_suppressed_forbidden", {
            owner,
            repo,
            target,
            reaction: content,
            status,
          });
          return;
        }
        logDebug("ack_reaction_failed", {
          owner,
          repo,
          targetKind: target.kind,
          reaction: content,
          message: errorMessage(e),
        });
      }
    }),
  );
}

async function postSlashReply(
  token: string,
  owner: string,
  repo: string,
  target: ReplyTarget,
  body: string,
  expiresAtTs?: number,
): Promise<{ commentId: number }> {
  const octokit = installationOctokit(token, expiresAtTs);
  if (target.kind === "inlineReviewThread") {
    const { data } = await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: target.prNumber,
      comment_id: target.inReplyToCommentId,
      body,
    });
    return { commentId: data.id };
  }
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: target.prNumber,
    body,
  });
  return { commentId: data.id };
}

async function getPullRequestHead(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  expiresAtTs?: number,
): Promise<{ headSha: string; pullRequest: PullRequestForFileList }> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return { headSha: data.head.sha, pullRequest: data };
}

async function createGithubCheckRunOrRecoverDuplicate(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  externalId: string,
  summary: string,
  expiresAtTs: number,
): Promise<{ id: number; url: string | null }> {
  try {
    return await createReviewCheckRun(
      token,
      owner,
      repo,
      {
        name: REVIEW_CHECK_RUN_NAME,
        headSha,
        externalId,
        summary,
      },
      expiresAtTs,
    );
  } catch (createError) {
    if (!isDuplicateCheckRunCreationError(createError)) throw createError;
    const duplicate = await findReviewCheckRunByName(
      token,
      owner,
      repo,
      headSha,
      REVIEW_CHECK_RUN_NAME,
      externalId,
      expiresAtTs,
    );
    if (duplicate == null) throw createError;
    return duplicate;
  }
}

export function createPrSurfaceImpl(params: CreatePrSurfaceParams): PrSurface {
  const { cfg, installationId, owner, repo, prNumber } = params;
  let installation: InstallationToken | undefined = params.installation;
  let botUserId: number | undefined;
  let botIdentityLoaded = false;

  async function ensureAuth(): Promise<{ token: string; expiresAtTs: number }> {
    if (params.tokenResolver) {
      installation = await params.tokenResolver();
      return { token: installation.token, expiresAtTs: installation.expiresAtTs };
    }
    if (installation != null && !isInstallationTokenNearExpiry(installation.expiresAtTs)) {
      return { token: installation.token, expiresAtTs: installation.expiresAtTs };
    }
    const fresh = await mintInstallationToken(cfg, installationId);
    installation = fresh;
    return { token: fresh.token, expiresAtTs: fresh.expiresAtTs };
  }

  async function ensureBotUserId(): Promise<number | undefined> {
    if (botIdentityLoaded) return botUserId;
    try {
      const bot = await getAppBotIdentity(cfg);
      botUserId = bot.userId;
      botIdentityLoaded = true;
    } catch (error) {
      logWarn("pr_surface_bot_identity_failed", {
        installationId,
        owner,
        repo,
        message: sanitizeLogMessage(errorMessage(error)),
      });
      botUserId = undefined;
    }
    return botUserId;
  }

  const surface = {
    owner,
    repo,
    prNumber,
    capabilities: params.capabilities,

    async getHead() {
      const { token, expiresAtTs } = await ensureAuth();
      return getPullRequestHead(token, owner, repo, prNumber, expiresAtTs);
    },

    async getHeadSha() {
      return (await this.getHead()).headSha;
    },

    async getBotLogin() {
      return (await getAppBotIdentity(cfg)).login;
    },

    async setAcknowledgementReaction(targets, kind) {
      const { token, expiresAtTs } = await ensureAuth();
      const botId = await ensureBotUserId();
      await reactOnAckTargets(
        token,
        owner,
        repo,
        targets,
        kind,
        botId,
        expiresAtTs,
        params.capabilities != null,
      );
    },

    async replyAt(target, body) {
      const { token, expiresAtTs } = await ensureAuth();
      return postSlashReply(token, owner, repo, target, body, expiresAtTs);
    },

    async findProgressComment(sentinel) {
      const { token, expiresAtTs } = await ensureAuth();
      const found = await findIssueCommentBySentinel(
        token,
        owner,
        repo,
        prNumber,
        sentinel,
        expiresAtTs,
      );
      return found ? { id: found.id, url: found.url, body: found.body } : null;
    },

    async resolveProgressComment(sentinel, hintCommentId) {
      const { token, expiresAtTs } = await ensureAuth();
      const resolved = await resolveVerifiedSummaryCommentRef(
        token,
        owner,
        repo,
        prNumber,
        sentinel,
        hintCommentId,
        expiresAtTs,
      );
      if (!resolved) return null;
      const { source: _source, ...ref } = resolved;
      return ref;
    },

    async upsertProgressComment(body, sentinel, knownExisting) {
      const { token, expiresAtTs } = await ensureAuth();
      const mappedKnown =
        knownExisting == null ? knownExisting : { id: knownExisting.id, url: knownExisting.url };
      return upsertReviewSummaryComment(
        token,
        owner,
        repo,
        prNumber,
        body,
        sentinel,
        mappedKnown,
        expiresAtTs,
      );
    },

    async editComment(commentId, body) {
      const { token, expiresAtTs } = await ensureAuth();
      await updateIssueComment(token, owner, repo, commentId, body, expiresAtTs);
    },

    async listReviewComments() {
      const { token, expiresAtTs } = await ensureAuth();
      return listReviewCommentsForPr(token, owner, repo, prNumber, expiresAtTs);
    },

    async listPullRequestReviews() {
      const { token, expiresAtTs } = await ensureAuth();
      return listPullRequestReviewsForPr(token, owner, repo, prNumber, expiresAtTs);
    },

    async setReviewCommitStatus(headSha, status) {
      const { token, expiresAtTs } = await ensureAuth();
      await setReviewCommitStatus(token, owner, repo, headSha, status, expiresAtTs);
    },

    async publishThreadBatch(review: ThreadBatchReview) {
      const { token, expiresAtTs } = await ensureAuth();
      const result = await createPullRequestReviewWithComments(
        token,
        owner,
        repo,
        prNumber,
        {
          body: review.body,
          event: review.event,
          comments: review.comments ? [...review.comments] : undefined,
          commitId: review.commitId,
        },
        expiresAtTs,
      );
      return { reviewId: result.id, reviewUrl: result.url };
    },

    async listInlineReviewThreads() {
      const { token, expiresAtTs } = await ensureAuth();
      return listReviewThreadResolution(token, owner, repo, prNumber, expiresAtTs);
    },

    async resolveInlineReviewThread(threadId) {
      const { token, expiresAtTs } = await ensureAuth();
      await resolveReviewThread(token, threadId, expiresAtTs);
    },

    async listChangedFiles(caps, pullRequest) {
      const { token, expiresAtTs } = await ensureAuth();
      return fetchPullRequestFiles(token, owner, repo, prNumber, caps, pullRequest, expiresAtTs);
    },

    async listCommitCompareFiles(base, head) {
      const { token, expiresAtTs } = await ensureAuth();
      return listCommitCompareFiles({
        token,
        tokenExpiresAtTs: expiresAtTs,
        owner,
        repo,
        base,
        head,
      });
    },

    async getLabels() {
      const { token, expiresAtTs } = await ensureAuth();
      return listPullRequestLabels(token, owner, repo, prNumber, expiresAtTs);
    },

    async setLabels(labels) {
      const { token, expiresAtTs } = await ensureAuth();
      await setPullRequestLabels(token, owner, repo, prNumber, [...labels], expiresAtTs);
    },

    async startReviewCheck(headSha, externalId, summary = "PR Agent review is in progress.") {
      const { token, expiresAtTs } = await ensureAuth();
      return createGithubCheckRunOrRecoverDuplicate(
        token,
        owner,
        repo,
        headSha,
        externalId,
        summary,
        expiresAtTs,
      );
    },

    async findReviewCheck(headSha, externalId) {
      const { token, expiresAtTs } = await ensureAuth();
      return findReviewCheckRunByName(
        token,
        owner,
        repo,
        headSha,
        REVIEW_CHECK_RUN_NAME,
        externalId,
        expiresAtTs,
      );
    },

    async finishReviewCheck(outcome: ReviewCheckOutcome) {
      const { token, expiresAtTs } = await ensureAuth();
      const name = outcome.name ?? REVIEW_CHECK_RUN_NAME;
      await updateReviewCheckRun(
        token,
        owner,
        repo,
        outcome.checkRunId,
        {
          name,
          conclusion: outcome.conclusion,
          completedAt: new Date().toISOString(),
          summary: outcome.summary,
          detailsUrl: outcome.detailsUrl,
        },
        expiresAtTs,
      );
    },

    async getCiStatus(headSha) {
      const { token, expiresAtTs } = await ensureAuth();
      return readCiStatusSources({
        token,
        owner,
        repo,
        headSha,
        expiresAtTs,
        capabilityPolicy: params.capabilities,
      });
    },

    async getReviewCommitStatuses(headSha) {
      const { token, expiresAtTs } = await ensureAuth();
      const result = await listLegacyCommitStatusesForHeadDetailed(
        token,
        owner,
        repo,
        headSha,
        expiresAtTs,
      );
      if (result.truncated) {
        throw new AppError({
          domain: "github",
          kind: "preflight_unavailable",
          message: "GitHub commit-status evidence is incomplete",
        });
      }
      return result.legacyStatuses;
    },

    async listPullsForHead(headSha) {
      const { token, expiresAtTs } = await ensureAuth();
      return listPullsForHead(token, owner, repo, headSha, expiresAtTs);
    },

    async listFailingActionsJobs(headSha) {
      const { token, expiresAtTs } = await ensureAuth();
      const result = await listFailingActionsJobsForHead(token, owner, repo, headSha, expiresAtTs);
      if (!result.ok) await params.capabilities?.deny("actionsRead");
      return result;
    },

    async downloadActionsJobLogs(jobId) {
      const { token, expiresAtTs } = await ensureAuth();
      const result = await downloadActionsJobLogs(token, owner, repo, jobId, expiresAtTs);
      if (!result.ok && result.reason === "actions_permission")
        await params.capabilities?.deny("actionsRead");
      return result;
    },

    async gitCredentialAuth() {
      return ensureAuth();
    },

    async listConversationComments() {
      const { token, expiresAtTs } = await ensureAuth();
      return listConversationCommentsForPr(token, owner, repo, prNumber, expiresAtTs);
    },

    async editReviewComment(commentId, body) {
      const { token, expiresAtTs } = await ensureAuth();
      const octokit = installationOctokit(token, expiresAtTs);
      try {
        await octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: commentId,
          body,
        });
        return true;
      } catch (error) {
        if (httpStatus(error) === 404) return false;
        throw error;
      }
    },

    async updatePullRequest(update) {
      const { token, expiresAtTs } = await ensureAuth();
      const octokit = installationOctokit(token, expiresAtTs);
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        title: update.title,
        body: update.body,
      });
      return { prNumber };
    },

    async listPushedCommits() {
      const { token, expiresAtTs } = await ensureAuth();
      return listPushedCommitsForPr(token, owner, repo, prNumber, expiresAtTs);
    },

    async lookupGitHubUser(userId) {
      const { token, expiresAtTs } = await ensureAuth();
      const octokit = installationOctokit(token, expiresAtTs);
      try {
        const { data } = await octokit.rest.users.getById({ account_id: userId });
        return {
          id: data.id,
          login: data.login ?? "unknown",
          name: data.name ?? null,
          email: data.email ?? null,
          type: data.type ?? "User",
        };
      } catch {
        return null;
      }
    },
  } satisfies PrSurface;
  const policy = params.capabilities;
  if (!policy) return surface;
  function guard<Args extends unknown[], Result>(
    operation: InstallationOperation,
    original: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args) => {
      if (policy?.access(operation) === "denied") {
        throw new AppError({
          domain: "github",
          kind: "essential_access_denied",
          message: "GitHub installation operation is unavailable",
          context: { operation },
        });
      }
      try {
        return await original(...args);
      } catch (error) {
        if (!isConfirmedCapabilityDenial(error)) throw error;
        await policy?.deny(operation);
        throw new AppError({
          domain: "github",
          kind: "essential_access_denied",
          message: "GitHub denied installation operation",
          context: { operation },
          cause: error,
        });
      }
    };
  }
  return {
    ...surface,
    getHead: guard("pullRequestsRead", surface.getHead.bind(surface)),
    getHeadSha: guard("pullRequestsRead", surface.getHeadSha.bind(surface)),
    getReviewCommitStatuses: guard("statusesRead", surface.getReviewCommitStatuses.bind(surface)),
    setAcknowledgementReaction: guard(
      "reactionsWrite",
      surface.setAcknowledgementReaction.bind(surface),
    ),
    replyAt: guard("commentsWrite", surface.replyAt.bind(surface)),
    findProgressComment: guard("pullRequestsRead", surface.findProgressComment.bind(surface)),
    resolveProgressComment: guard("pullRequestsRead", surface.resolveProgressComment.bind(surface)),
    upsertProgressComment: guard("commentsWrite", surface.upsertProgressComment.bind(surface)),
    editComment: guard("commentsWrite", surface.editComment.bind(surface)),
    listReviewComments: guard("pullRequestsRead", surface.listReviewComments.bind(surface)),
    listPullRequestReviews: guard("pullRequestsRead", surface.listPullRequestReviews.bind(surface)),
    setReviewCommitStatus: guard("statusesWrite", surface.setReviewCommitStatus.bind(surface)),
    publishThreadBatch: guard("reviewWrite", surface.publishThreadBatch.bind(surface)),
    listInlineReviewThreads: guard(
      "pullRequestsRead",
      surface.listInlineReviewThreads.bind(surface),
    ),
    resolveInlineReviewThread: guard(
      "reviewWrite",
      surface.resolveInlineReviewThread.bind(surface),
    ),
    listChangedFiles: guard("pullRequestsRead", surface.listChangedFiles.bind(surface)),
    listCommitCompareFiles: guard("contentsRead", surface.listCommitCompareFiles.bind(surface)),
    getLabels: guard("labelsRead", surface.getLabels.bind(surface)),
    setLabels: guard("labelsWrite", surface.setLabels.bind(surface)),
    startReviewCheck: guard("checksWrite", surface.startReviewCheck.bind(surface)),
    findReviewCheck: guard("checksRead", surface.findReviewCheck.bind(surface)),
    finishReviewCheck: guard("checksWrite", surface.finishReviewCheck.bind(surface)),
    listPullsForHead: guard("pullRequestsRead", surface.listPullsForHead.bind(surface)),
    listFailingActionsJobs: guard("actionsRead", surface.listFailingActionsJobs.bind(surface)),
    downloadActionsJobLogs: guard("actionsRead", surface.downloadActionsJobLogs.bind(surface)),
    gitCredentialAuth: guard("contentsRead", surface.gitCredentialAuth.bind(surface)),
    listConversationComments: guard(
      "pullRequestsRead",
      surface.listConversationComments.bind(surface),
    ),
    editReviewComment: guard("reviewWrite", surface.editReviewComment.bind(surface)),
    updatePullRequest: guard("reviewWrite", surface.updatePullRequest.bind(surface)),
    listPushedCommits: guard("pullRequestsRead", surface.listPushedCommits.bind(surface)),
  };
}
