import * as v from "valibot";
import { getAppBotIdentity, installationOctokit } from "./appAuth.js";
import type { InstallationToken } from "./appAuth.js";
import { nonErrorThrown } from "../errors/appError.js";
import { logDebug, logWarn } from "../evlog.js";
import { mintInstallationToken } from "./installationToken.js";
import { isInstallationTokenNearExpiry } from "./installationTokenExpiry.js";
import { downloadActionsJobLogs, listFailingActionsJobsForHead } from "./actionsLogs.js";
import { listCommitCompareFiles } from "./compareCommitFiles.js";
import {
  listCheckRunsForHead,
  listCheckRunAnnotations,
  listLegacyCommitStatusesForHead,
} from "./ciStatus.js";
import { fetchPullRequestFiles, type PullRequestForFileList } from "./listPullRequestFiles.js";
import { createRateLimitCircuit } from "./rateLimitCircuit.js";
import { httpStatus } from "./httpStatus.js";
import {
  createPullRequestReviewWithComments,
  createReviewCheckRun,
  findIssueCommentBySentinel,
  findReviewCheckRunByName,
  getIssueCommentIfSentinel,
  listPullRequestLabels,
  listPullRequestReviewComments,
  setPullRequestLabels,
  setReviewCommitStatus,
  updateIssueComment,
  updateReviewCheckRun,
  upsertReviewSummaryComment,
} from "./reviewPublish.js";
import {
  fetchBotFindingThreads,
  fetchPriorInlineReviewFeedback,
  fetchReviewCommentParentGraph,
} from "./reviewPriorFeedbackIo.js";
import { withTransientReviewRetry } from "./reviewPublishRetry.js";
import { listReviewThreadResolution, resolveReviewThread } from "./reviewThreadResolution.js";
import { paginateOctokitPages } from "./paginateOctokit.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { mergeDescriptionIntoPrBody } from "../agent/description/descriptionBodyMerge.js";
import { renderDescriptionAgentBlock } from "../agent/description/descriptionRender.js";
import type { DescriptionPayload } from "../agent/description/descriptionSchema.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
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
  PrConversationComment,
  PrSurface,
  ReviewCheckOutcome,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";

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
      "in_reply_to_id" in comment && v.is(v.number(), comment.in_reply_to_id)
        ? comment.in_reply_to_id
        : null,
    authorLogin: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
  }));
}

async function listInlineReviewCommentsForPr(
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
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page,
      });
      return data;
    },
  });
  return rows.map((comment) => ({
    id: comment.id,
    inReplyToId: comment.in_reply_to_id ?? null,
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

async function publishDescriptionOnPullRequest(params: {
  readonly cfg: Pick<import("../config.js").Config, "features">;
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly payload: DescriptionPayload;
}) {
  const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber, payload } = params;
  const octokit = installationOctokit(token, tokenExpiresAtTs);
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const agentBlock = renderDescriptionAgentBlock(payload, {
    owner,
    repo,
    prNumber,
  });
  const mergedBody = mergeDescriptionIntoPrBody({
    currentBody: pr.body,
    agentBlock,
  });

  const nextTitle = cfg.features.titleRewrite ? payload.title.trim() : (pr.title ?? "");
  const titleUpdated = cfg.features.titleRewrite && nextTitle !== (pr.title ?? "");
  const bodyUpdated = mergedBody !== (pr.body ?? "");

  if (titleUpdated || bodyUpdated) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      title: nextTitle,
      body: mergedBody,
    });
  }

  return { prNumber, titleUpdated, bodyUpdated };
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

const listedReactionSchema = v.object({
  id: v.number(),
  content: v.string(),
  user: v.nullable(v.object({ id: v.number() })),
});

async function safeReaction(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  content: GithubReactionContent = GITHUB_REACTION_EYES,
  expiresAtTs?: number,
): Promise<void> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    if (target.kind === "pr") {
      await octokit.rest.reactions.createForIssue({
        owner,
        repo,
        issue_number: target.prNumber,
        content,
      });
    } else if (target.kind === "issueComment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: target.commentId,
        content,
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: target.commentId,
        content,
      });
    }
  } catch (error) {
    const err = error instanceof Error ? error : nonErrorThrown("github.reaction_create");
    const status = httpStatus(err);
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
    if (status === 422) return;
    throw err;
  }
}

async function listLifecycleReactions(
  token: string,
  owner: string,
  repo: string,
  target: AcknowledgementTarget,
  expiresAtTs?: number,
): Promise<readonly ListedReaction[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const rows =
    target.kind === "pr"
      ? await octokit.paginate(octokit.rest.reactions.listForIssue, {
          owner,
          repo,
          issue_number: target.prNumber,
          per_page: 100,
        })
      : target.kind === "issueComment"
        ? await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
            owner,
            repo,
            comment_id: target.commentId,
            per_page: 100,
          })
        : await octokit.paginate(octokit.rest.reactions.listForPullRequestReviewComment, {
            owner,
            repo,
            comment_id: target.commentId,
            per_page: 100,
          });
  return v.parse(v.array(listedReactionSchema), rows);
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
  if (target.kind === "pr") {
    await octokit.rest.reactions.deleteForIssue({
      owner,
      repo,
      issue_number: target.prNumber,
      reaction_id: reactionId,
    });
    return;
  }
  if (target.kind === "issueComment") {
    await octokit.rest.reactions.deleteForIssueComment({
      owner,
      repo,
      comment_id: target.commentId,
      reaction_id: reactionId,
    });
    return;
  }
  await octokit.rest.reactions.deleteForPullRequestComment({
    owner,
    repo,
    comment_id: target.commentId,
    reaction_id: reactionId,
  });
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
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      try {
        await setLifecycleReaction(token, owner, repo, target, content, botUserId, expiresAtTs);
      } catch (e) {
        logDebug("ack_reaction_failed", {
          owner,
          repo,
          targetKind: target.kind,
          reaction: content,
          message: e instanceof Error ? e.message : String(e),
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
    const err =
      createError instanceof Error ? createError : nonErrorThrown("github.check_run_create");
    if (httpStatus(err) !== 422) throw err;
    const duplicate = await findReviewCheckRunByName(
      token,
      owner,
      repo,
      headSha,
      REVIEW_CHECK_RUN_NAME,
      expiresAtTs,
    );
    if (duplicate == null) throw err;
    return duplicate;
  }
}

export function createPrSurfaceImpl(params: CreatePrSurfaceParams): PrSurface {
  const { cfg, installationId, owner, repo, prNumber } = params;
  let installation: InstallationToken | undefined = params.installation;
  const rateLimitCircuit = params.rateLimitCircuit ?? createRateLimitCircuit({ installationId });
  let botUserId: number | undefined;
  let botIdentityLoaded = false;

  async function ensureAuth(): Promise<{ token: string; expiresAtTs: number }> {
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
        message: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
      });
      botUserId = undefined;
    }
    return botUserId;
  }

  return {
    owner,
    repo,
    prNumber,

    async getHead() {
      const { token, expiresAtTs } = await ensureAuth();
      return getPullRequestHead(token, owner, repo, prNumber, expiresAtTs);
    },

    async getHeadSha() {
      return (await this.getHead()).headSha;
    },

    async setAcknowledgementReaction(targets, kind) {
      const { token, expiresAtTs } = await ensureAuth();
      const botId = await ensureBotUserId();
      await reactOnAckTargets(token, owner, repo, targets, kind, botId, expiresAtTs);
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
      if (hintCommentId != null) {
        const verified = await getIssueCommentIfSentinel(
          token,
          owner,
          repo,
          hintCommentId,
          sentinel,
          expiresAtTs,
        );
        if (verified) return verified;
      }
      return this.findProgressComment(sentinel);
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

    async listPullRequestReviewComments() {
      const { token, expiresAtTs } = await ensureAuth();
      return listPullRequestReviewComments(token, owner, repo, prNumber, expiresAtTs);
    },

    async setReviewCommitStatus(headSha, status) {
      const { token, expiresAtTs } = await ensureAuth();
      await setReviewCommitStatus(token, owner, repo, headSha, status, expiresAtTs);
    },

    async fetchPriorInlineFeedback(botUserId) {
      const { token, expiresAtTs } = await ensureAuth();
      return fetchPriorInlineReviewFeedback(token, owner, repo, prNumber, botUserId, expiresAtTs);
    },

    async fetchBotFindingThreads(botUserId, publishRecordLenses) {
      const { token, expiresAtTs } = await ensureAuth();
      return fetchBotFindingThreads(
        token,
        owner,
        repo,
        prNumber,
        botUserId,
        publishRecordLenses,
        expiresAtTs,
      );
    },

    async fetchReviewCommentParentGraph() {
      const { token, expiresAtTs } = await ensureAuth();
      return fetchReviewCommentParentGraph(token, owner, repo, prNumber, expiresAtTs);
    },

    async publishThreadBatch(review: ThreadBatchReview) {
      const { token, expiresAtTs } = await ensureAuth();
      const result = await withTransientReviewRetry(() =>
        createPullRequestReviewWithComments(
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
        ),
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
      const [checkRuns, legacyStatuses] = await Promise.all([
        listCheckRunsForHead(token, owner, repo, headSha, expiresAtTs),
        listLegacyCommitStatusesForHead(token, owner, repo, headSha, expiresAtTs),
      ]);
      return { checkRuns, legacyStatuses };
    },

    async listFailingActionsJobs(headSha) {
      const { token, expiresAtTs } = await ensureAuth();
      return listFailingActionsJobsForHead(token, owner, repo, headSha, expiresAtTs);
    },

    async downloadActionsJobLogs(jobId) {
      const { token, expiresAtTs } = await ensureAuth();
      return downloadActionsJobLogs(token, owner, repo, jobId, expiresAtTs);
    },

    async listCheckRunAnnotations(checkRunId) {
      const { token, expiresAtTs } = await ensureAuth();
      return listCheckRunAnnotations(token, owner, repo, checkRunId, expiresAtTs);
    },

    async gitCredentialAuth() {
      return ensureAuth();
    },

    async gitCredentialToken() {
      return (await ensureAuth()).token;
    },

    async listConversationComments() {
      const { token, expiresAtTs } = await ensureAuth();
      return listConversationCommentsForPr(token, owner, repo, prNumber, expiresAtTs);
    },

    async listInlineReviewComments() {
      const { token, expiresAtTs } = await ensureAuth();
      return listInlineReviewCommentsForPr(token, owner, repo, prNumber, expiresAtTs);
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
        const err = error instanceof Error ? error : nonErrorThrown("github.review_comment_update");
        if (httpStatus(err) === 404) return false;
        throw err;
      }
    },

    async getPullRequestBody() {
      const { token, expiresAtTs } = await ensureAuth();
      const octokit = installationOctokit(token, expiresAtTs);
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return data.body ?? null;
    },

    async getPullRequestBranchInfo() {
      const { token, expiresAtTs } = await ensureAuth();
      const octokit = installationOctokit(token, expiresAtTs);
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return {
        headRef: data.head.ref,
        sameRepo: data.head.repo?.full_name === data.base.repo?.full_name,
      };
    },

    async publishDescription(cfg, payload) {
      const { token, expiresAtTs } = await ensureAuth();
      return publishDescriptionOnPullRequest({
        cfg,
        token,
        tokenExpiresAtTs: expiresAtTs,
        owner,
        repo,
        prNumber,
        payload,
      });
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

    isRateLimitCircuitOpen() {
      return rateLimitCircuit.isOpen();
    },
  };
}
