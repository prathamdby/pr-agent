import type { ReplyTarget } from "../commands/replyTarget.js";
import type {
  ListPullRequestFilesLimits,
  ListPullRequestFilesResult,
  PullRequestForFileList,
} from "./listPullRequestFiles.js";
import type { ListCommitCompareFilesResult } from "./compareCommitFiles.js";
import type {
  ReviewThreadResolution,
  ReviewThreadResolutionStatus,
} from "./reviewThreadResolution.js";
import type { GithubReactionContent } from "../settings/index.js";
import type {
  AcknowledgementTarget,
  CreatePrSurfaceParams,
  PrConversationComment,
  PublishedBatch,
  PrSurface,
  PrSurfaceMutationBoundary,
  PullRequestBranchInfo,
  PushedCommitSummary,
  ReviewCommentParentNode,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
import { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.js";
import type { DescriptionPayload } from "../agent/description/descriptionSchema.js";
import type { BotFindingThread, ReviewThreadReply } from "../review/run/reviewPriorFeedback.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";
import type { CiCheckRunSnapshot, CiLegacyStatus } from "../review/ci/ciSummaryTypes.js";

export type FakePrSurfaceEvent =
  | { readonly kind: "getHead" }
  | { readonly kind: "getHeadSha" }
  | {
      readonly kind: "setAcknowledgementReaction";
      readonly targets: readonly AcknowledgementTarget[];
      readonly reaction: GithubReactionContent;
    }
  | { readonly kind: "replyAt"; readonly target: ReplyTarget; readonly body: string }
  | { readonly kind: "findProgressComment"; readonly sentinel: string }
  | {
      readonly kind: "resolveProgressComment";
      readonly sentinel: string;
      readonly hintCommentId?: number | null;
    }
  | {
      readonly kind: "upsertProgressComment";
      readonly body: string;
      readonly sentinel: string;
      readonly knownExisting?: { readonly id: number; readonly url: string } | null;
    }
  | { readonly kind: "listPullRequestReviewComments" }
  | {
      readonly kind: "setReviewCommitStatus";
      readonly headSha: string;
      readonly status: {
        readonly state: string;
        readonly description: string;
        readonly targetUrl?: string;
      };
    }
  | {
      readonly kind: "fetchPriorInlineFeedback";
      readonly botUserId: number;
      readonly currentLens: AnyReviewLens;
      readonly maintainerDecisionAssociations?: ReadonlySet<string>;
    }
  | {
      readonly kind: "fetchBotFindingThreads";
      readonly botUserId: number;
      readonly publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>;
      readonly maintainerDecisionAssociations?: ReadonlySet<string>;
    }
  | { readonly kind: "fetchReviewCommentParentGraph" }
  | { readonly kind: "editComment"; readonly commentId: number; readonly body: string }
  | { readonly kind: "publishThreadBatch"; readonly review: ThreadBatchReview }
  | { readonly kind: "listInlineReviewThreads" }
  | { readonly kind: "resolveInlineReviewThread"; readonly threadId: string }
  | { readonly kind: "listChangedFiles"; readonly caps: ListPullRequestFilesLimits }
  | { readonly kind: "listCommitCompareFiles"; readonly base: string; readonly head: string }
  | { readonly kind: "getLabels" }
  | { readonly kind: "setLabels"; readonly labels: readonly string[] }
  | {
      readonly kind: "startReviewCheck";
      readonly headSha: string;
      readonly externalId: string;
      readonly summary?: string;
    }
  | { readonly kind: "finishReviewCheck"; readonly checkRunId: number }
  | { readonly kind: "getCiStatus"; readonly headSha: string }
  | { readonly kind: "listFailingActionsJobs"; readonly headSha: string }
  | { readonly kind: "downloadActionsJobLogs"; readonly jobId: number }
  | { readonly kind: "listCheckRunAnnotations"; readonly checkRunId: number }
  | { readonly kind: "gitCredentialAuth" }
  | { readonly kind: "gitCredentialToken" }
  | { readonly kind: "listConversationComments" }
  | { readonly kind: "listInlineReviewComments" }
  | { readonly kind: "editReviewComment"; readonly commentId: number; readonly body: string }
  | { readonly kind: "getPullRequestBody" }
  | { readonly kind: "getPullRequestBranchInfo" }
  | { readonly kind: "publishDescription" }
  | { readonly kind: "listPushedCommits" }
  | { readonly kind: "lookupGitHubUser"; readonly userId: number };

export type FakePrSurfaceControls = {
  readonly events: FakePrSurfaceEvent[];
  readonly reactions: Array<{
    readonly targets: readonly AcknowledgementTarget[];
    readonly kind: GithubReactionContent;
  }>;
  readonly replies: Array<{ readonly target: ReplyTarget; readonly body: string }>;
  readonly threadBatches: ThreadBatchReview[];
  readonly setHeadSha: (headSha: string) => void;
  readonly setPullRequest: (pullRequest: PullRequestForFileList) => void;
  readonly setLabels: (labels: readonly string[]) => void;
  readonly setRateLimitOpen: (open: boolean) => void;
  readonly setCredentialToken: (token: string) => void;
  readonly setCredentialAuth: (auth: {
    readonly token: string;
    readonly expiresAtTs: number;
  }) => void;
  readonly setCiStatus: (
    headSha: string,
    status: {
      readonly checkRuns: readonly CiCheckRunSnapshot[];
      readonly legacyStatuses: readonly CiLegacyStatus[];
    },
  ) => void;
  readonly setCiStatusError: (error: unknown) => void;
  readonly setProgressComment: (sentinel: string, body: string, id?: number) => void;
  readonly getProgressComment: (
    sentinel: string,
  ) => { readonly id: number; readonly body: string } | null;
  readonly setFailingJobs: (
    headSha: string,
    jobs: Array<{
      readonly id: number;
      readonly name: string;
      readonly conclusion: string | null;
      readonly htmlUrl?: string | null;
    }>,
  ) => void;
  readonly setJobLogs: (jobId: number, text: string) => void;
  readonly setThreads: (threads: Map<number, ReviewThreadResolution>) => void;
  readonly setPriorInlineFeedback: (
    threads: Array<{
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly botTitleSnippet: string;
      readonly humanReplies: readonly string[];
      readonly authorizedReplies?: readonly string[];
      readonly untrustedReplies?: readonly string[];
      readonly replies?: readonly ReviewThreadReply[];
      readonly threadUrl: string;
    }>,
  ) => void;
  readonly setBotFindingThreads: (threads: readonly BotFindingThread[]) => void;
  readonly setReviewCommentParentGraph: (nodes: readonly ReviewCommentParentNode[]) => void;
  readonly setConversationComments: (comments: readonly PrConversationComment[]) => void;
  readonly setInlineReviewComments: (comments: readonly PrConversationComment[]) => void;
  readonly setPullRequestBody: (body: string | null) => void;
  readonly setPullRequestBranchInfo: (info: PullRequestBranchInfo) => void;
  readonly setPushedCommits: (commits: readonly PushedCommitSummary[]) => void;
  readonly setGithubUser: (
    userId: number,
    profile: {
      readonly id: number;
      readonly login: string;
      readonly name: string | null;
      readonly email: string | null;
      readonly type: string;
    } | null,
  ) => void;
  readonly setReviewCommentBody: (commentId: number, body: string) => void;
  readonly setChangedFilesResult: (result: ListPullRequestFilesResult) => void;
  readonly setCommitCompareFilesResult: (
    result:
      | ListCommitCompareFilesResult
      | ((base: string, head: string) => ListCommitCompareFilesResult),
  ) => void;
  readonly rejectNextInlineReviewReply: (error: Error) => void;
  readonly acceptThenRejectNextInlineReviewReply: (error: Error) => void;
  readonly setThreadResolutionStatus: (
    status: ReviewThreadResolutionStatus,
    warning?: string,
  ) => void;
};

type FakePrSurfaceOptions = {
  readonly headSha?: string;
  readonly pullRequest?: PullRequestForFileList;
  readonly labels?: readonly string[];
  readonly credentialToken?: string;
  readonly rateLimitOpen?: boolean;
  readonly mutationBoundary?: PrSurfaceMutationBoundary;
};

let nextCommentId = 1;
let nextReviewId = 1;
let nextCheckRunId = 1;

function defaultPullRequest(headSha: string): PullRequestForFileList {
  return {
    additions: 0,
    deletions: 0,
    changed_files: 0,
    state: "open",
    merged: false,
    merged_at: null,
    head: { sha: headSha },
  };
}

export function createFakePrSurface(
  params: Pick<CreatePrSurfaceParams, "owner" | "repo" | "prNumber">,
  options?: FakePrSurfaceOptions,
): { readonly surface: PrSurface; readonly controls: FakePrSurfaceControls } {
  const events: FakePrSurfaceEvent[] = [];
  const reactions: FakePrSurfaceControls["reactions"] = [];
  const replies: FakePrSurfaceControls["replies"] = [];
  const threadBatches: ThreadBatchReview[] = [];
  const publishedThreadBatches: Array<{
    readonly id: number;
    readonly url: string;
    readonly review: ThreadBatchReview;
    readonly authorLogin: string;
  }> = [];

  let headSha = options?.headSha ?? "fake-head-sha";
  let pullRequest = options?.pullRequest ?? defaultPullRequest(headSha);
  const issueComments = new Map<
    number,
    { readonly id: number; readonly body: string; readonly url: string }
  >();
  const progressBySentinel = new Map<string, number>();
  let labels = [...(options?.labels ?? [])];
  let rateLimitOpen = options?.rateLimitOpen ?? false;
  let credentialToken = options?.credentialToken ?? "fake-git-token";
  let credentialExpiresAtTs = Date.now() + 3_600_000;
  let ciStatusError: unknown;
  const ciStatusByHead = new Map<
    string,
    {
      readonly checkRuns: CiCheckRunSnapshot[];
      readonly checkRunsComplete: boolean;
      readonly legacyStatuses: CiLegacyStatus[];
    }
  >();
  const threads = new Map<number, ReviewThreadResolution>();
  const checkRuns = new Map<
    number,
    {
      readonly id: number;
      readonly url: string | null;
      readonly headSha: string;
      readonly externalId: string;
    }
  >();
  const failingJobsByHead = new Map<
    string,
    Array<{
      readonly id: number;
      readonly name: string;
      readonly conclusion: string | null;
      readonly htmlUrl: string | null;
    }>
  >();
  const jobLogs = new Map<number, string>();
  let priorInlineFeedback: Array<{
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly botTitleSnippet: string;
    readonly humanReplies: readonly string[];
    readonly authorizedReplies?: readonly string[];
    readonly untrustedReplies?: readonly string[];
    readonly replies?: readonly ReviewThreadReply[];
    readonly threadUrl: string;
  }> = [];
  let botFindingThreads: BotFindingThread[] = [];
  let reviewCommentParentGraph: ReviewCommentParentNode[] = [];
  let reviewComments: Array<{ path: string; line: number; id: number; url: string }> = [];
  let conversationComments: PrConversationComment[] = [];
  let inlineReviewComments: PrConversationComment[] = [];
  let pullRequestBody: string | null = null;
  let pullRequestBranchInfo: PullRequestBranchInfo = { headRef: "branch", sameRepo: true };
  let pushedCommits: PushedCommitSummary[] = [];
  const githubUsers = new Map<
    number,
    { id: number; login: string; name: string | null; email: string | null; type: string }
  >();
  const reviewCommentBodies = new Map<number, string>();
  let changedFilesResult: ListPullRequestFilesResult = {
    files: [],
    truncated: false,
    omittedCountLowerBound: 0,
    totalChanges: 0,
    headSha,
  };
  let commitCompareFilesResult:
    | ListCommitCompareFilesResult
    | ((base: string, head: string) => ListCommitCompareFilesResult) = {
    files: [],
    truncated: false,
  };
  let inlineReplyError: Error | null = null;
  let inlineReplyAcceptedBeforeError = false;
  let threadResolutionStatus: ReviewThreadResolutionStatus = "ok";
  let threadResolutionWarning: string | undefined;

  const controls: FakePrSurfaceControls = {
    events,
    reactions,
    replies,
    threadBatches,
    setHeadSha(next) {
      headSha = next;
      pullRequest = { ...pullRequest, head: { sha: next } };
    },
    setPullRequest(next) {
      pullRequest = next;
      if (next.head?.sha) headSha = next.head.sha;
    },
    setLabels(next) {
      labels = [...next];
    },
    setRateLimitOpen(open) {
      rateLimitOpen = open;
    },
    setCredentialToken(token) {
      credentialToken = token;
    },
    setCredentialAuth(auth) {
      credentialToken = auth.token;
      credentialExpiresAtTs = auth.expiresAtTs;
    },
    setCiStatus(head, status) {
      ciStatusByHead.set(head, {
        checkRuns: [...status.checkRuns],
        checkRunsComplete: true,
        legacyStatuses: [...status.legacyStatuses],
      });
      ciStatusError = undefined;
    },
    setCiStatusError(error) {
      ciStatusError = error;
    },
    setProgressComment(sentinel, body, id) {
      const commentId = id ?? nextCommentId++;
      progressBySentinel.set(sentinel, commentId);
      issueComments.set(commentId, {
        id: commentId,
        body: body.includes(sentinel) ? body : `${sentinel}\n${body}`,
        url: `https://github.com/${params.owner}/${params.repo}/issues/${params.prNumber}#issuecomment-${commentId}`,
      });
    },
    getProgressComment(sentinel) {
      const id = progressBySentinel.get(sentinel);
      if (id == null) return null;
      const comment = issueComments.get(id);
      return comment ? { id: comment.id, body: comment.body } : null;
    },
    setFailingJobs(head, jobs) {
      failingJobsByHead.set(
        head,
        jobs.map((job) => ({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion,
          htmlUrl: job.htmlUrl ?? null,
        })),
      );
    },
    setJobLogs(jobId, text) {
      jobLogs.set(jobId, text);
    },
    setThreads(next) {
      threads.clear();
      for (const [key, value] of next) {
        threads.set(key, value);
      }
    },
    setPriorInlineFeedback(next) {
      priorInlineFeedback = [...next];
    },
    setBotFindingThreads(threads) {
      botFindingThreads = [...threads];
    },
    setReviewCommentParentGraph(nodes) {
      reviewCommentParentGraph = [...nodes];
    },
    setConversationComments(next) {
      conversationComments = [...next];
    },
    setInlineReviewComments(next) {
      inlineReviewComments = [...next];
    },
    setPullRequestBody(body) {
      pullRequestBody = body;
    },
    setPullRequestBranchInfo(info) {
      pullRequestBranchInfo = info;
    },
    setPushedCommits(commits) {
      pushedCommits = [...commits];
    },
    setGithubUser(userId, profile) {
      if (profile == null) githubUsers.delete(userId);
      else githubUsers.set(userId, profile);
    },
    setReviewCommentBody(commentId, body) {
      reviewCommentBodies.set(commentId, body);
    },
    setChangedFilesResult(result) {
      changedFilesResult = result;
    },
    setCommitCompareFilesResult(result) {
      commitCompareFilesResult = result;
    },
    rejectNextInlineReviewReply(error) {
      inlineReplyError = error;
      inlineReplyAcceptedBeforeError = false;
    },
    acceptThenRejectNextInlineReviewReply(error) {
      inlineReplyError = error;
      inlineReplyAcceptedBeforeError = true;
    },
    setThreadResolutionStatus(status, warning) {
      threadResolutionStatus = status;
      threadResolutionWarning = warning;
    },
  };

  const surface: PrSurface = {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,

    async getHead() {
      events.push({ kind: "getHead" });
      return { headSha, pullRequest };
    },

    async getHeadSha() {
      events.push({ kind: "getHeadSha" });
      return headSha;
    },

    async getBotLogin() {
      return "pr-agent[bot]";
    },

    async setAcknowledgementReaction(targets, kind) {
      events.push({ kind: "setAcknowledgementReaction", targets, reaction: kind });
      reactions.push({ targets: [...targets], kind });
    },

    async replyAt(target, body) {
      const shouldThrowAfterAccept =
        target.kind === "inlineReviewThread" &&
        inlineReplyError != null &&
        inlineReplyAcceptedBeforeError;
      if (
        target.kind === "inlineReviewThread" &&
        inlineReplyError != null &&
        !shouldThrowAfterAccept
      ) {
        const error = inlineReplyError;
        inlineReplyError = null;
        inlineReplyAcceptedBeforeError = false;
        throw error;
      }
      events.push({ kind: "replyAt", target, body });
      replies.push({ target, body });
      const commentId = nextCommentId++;
      if (target.kind === "inlineReviewThread") {
        reviewCommentBodies.set(commentId, body);
        inlineReviewComments.push({
          id: commentId,
          inReplyToId: target.inReplyToCommentId,
          authorLogin: "pr-agent[bot]",
          body,
        });
      }
      issueComments.set(commentId, {
        id: commentId,
        body,
        url: `https://github.com/${params.owner}/${params.repo}/issues/${params.prNumber}#issuecomment-${commentId}`,
      });
      if (shouldThrowAfterAccept) {
        const error = inlineReplyError;
        inlineReplyError = null;
        inlineReplyAcceptedBeforeError = false;
        throw error;
      }
      return { commentId };
    },

    async findProgressComment(sentinel) {
      events.push({ kind: "findProgressComment", sentinel });
      const comment = controls.getProgressComment(sentinel);
      if (comment == null) return null;
      const stored = issueComments.get(comment.id);
      return stored ? { id: stored.id, url: stored.url, body: stored.body } : null;
    },

    async resolveProgressComment(sentinel, hintCommentId) {
      events.push({ kind: "resolveProgressComment", sentinel, hintCommentId });
      if (hintCommentId != null) {
        const hinted = issueComments.get(hintCommentId);
        if (hinted?.body.includes(sentinel)) {
          return { id: hinted.id, url: hinted.url, body: hinted.body };
        }
      }
      return this.findProgressComment(sentinel);
    },

    async upsertProgressComment(body, sentinel, knownExisting) {
      events.push({ kind: "upsertProgressComment", body, sentinel, knownExisting });
      if (knownExisting != null) {
        const existing = issueComments.get(knownExisting.id);
        if (existing != null) {
          issueComments.set(knownExisting.id, { ...existing, body });
          progressBySentinel.set(sentinel, knownExisting.id);
          return { id: knownExisting.id, updated: true };
        }
      }
      const existingId = progressBySentinel.get(sentinel);
      if (existingId != null) {
        const existing = issueComments.get(existingId);
        if (existing != null) {
          issueComments.set(existingId, { ...existing, body });
          return { id: existingId, updated: true };
        }
      }
      for (const [id, comment] of issueComments) {
        if (comment.body.includes(sentinel)) {
          progressBySentinel.set(sentinel, id);
          issueComments.set(id, { ...comment, body });
          return { id, updated: true };
        }
      }
      const commentId = nextCommentId++;
      progressBySentinel.set(sentinel, commentId);
      issueComments.set(commentId, {
        id: commentId,
        body,
        url: `https://github.com/${params.owner}/${params.repo}/issues/${params.prNumber}#issuecomment-${commentId}`,
      });
      return { id: commentId, updated: false };
    },

    async listPullRequestReviewComments() {
      events.push({ kind: "listPullRequestReviewComments" });
      return { comments: reviewComments, truncated: false };
    },

    async setReviewCommitStatus(headShaArg, status) {
      events.push({ kind: "setReviewCommitStatus", headSha: headShaArg, status });
    },

    async fetchPriorInlineFeedback(botUserId, currentLens, maintainerDecisionAssociations) {
      events.push({
        kind: "fetchPriorInlineFeedback",
        botUserId,
        currentLens,
        ...(maintainerDecisionAssociations != null ? { maintainerDecisionAssociations } : {}),
      });
      return priorInlineFeedback;
    },

    async fetchBotFindingThreads(botUserId, publishRecordLenses, maintainerDecisionAssociations) {
      events.push({
        kind: "fetchBotFindingThreads",
        botUserId,
        publishRecordLenses,
        ...(maintainerDecisionAssociations != null ? { maintainerDecisionAssociations } : {}),
      });
      return botFindingThreads;
    },

    async fetchReviewCommentParentGraph() {
      events.push({ kind: "fetchReviewCommentParentGraph" });
      return reviewCommentParentGraph;
    },

    async editComment(commentId, body) {
      events.push({ kind: "editComment", commentId, body });
      const existing = issueComments.get(commentId);
      if (existing != null) {
        issueComments.set(commentId, { ...existing, body });
      }
    },

    async publishThreadBatch(review) {
      events.push({ kind: "publishThreadBatch", review });
      threadBatches.push(review);
      const reviewId = nextReviewId++;
      const reviewUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}#pullrequestreview-${reviewId}`;
      publishedThreadBatches.push({
        id: reviewId,
        url: reviewUrl,
        review,
        authorLogin: "pr-agent[bot]",
      });
      return {
        reviewId,
        reviewUrl,
      };
    },

    async findPublishedThreadBatch(marker, commitId): Promise<PublishedBatch | null> {
      for (let index = publishedThreadBatches.length - 1; index >= 0; index -= 1) {
        const review = publishedThreadBatches[index];
        if (
          review != null &&
          review.authorLogin === "pr-agent[bot]" &&
          review.review.body.includes(marker) &&
          (commitId == null || review.review.commitId === commitId)
        ) {
          return { reviewId: review.id, reviewUrl: review.url };
        }
      }
      return null;
    },

    async listInlineReviewThreads() {
      events.push({ kind: "listInlineReviewThreads" });
      return {
        byRootCommentId: new Map(threads),
        status: threadResolutionStatus,
        ...(threadResolutionWarning != null ? { warning: threadResolutionWarning } : {}),
      };
    },

    async resolveInlineReviewThread(threadId) {
      events.push({ kind: "resolveInlineReviewThread", threadId });
      for (const [rootId, thread] of threads) {
        if (thread.threadNodeId === threadId) {
          threads.set(rootId, { ...thread, isResolved: true });
        }
      }
    },

    async listChangedFiles(caps) {
      events.push({ kind: "listChangedFiles", caps });
      return { ...changedFilesResult, headSha: changedFilesResult.headSha ?? headSha };
    },

    async listCommitCompareFiles(base, head) {
      events.push({ kind: "listCommitCompareFiles", base, head });
      return typeof commitCompareFilesResult === "function"
        ? commitCompareFilesResult(base, head)
        : commitCompareFilesResult;
    },

    async getLabels() {
      events.push({ kind: "getLabels" });
      return [...labels];
    },

    async setLabels(next) {
      events.push({ kind: "setLabels", labels: next });
      labels = [...next];
    },

    async startReviewCheck(headShaArg, externalId, summary) {
      events.push({ kind: "startReviewCheck", headSha: headShaArg, externalId, summary });
      const id = nextCheckRunId++;
      const url = `https://github.com/${params.owner}/${params.repo}/runs/${id}`;
      checkRuns.set(id, { id, url, headSha: headShaArg, externalId });
      return { id, url };
    },

    async findReviewCheck(headShaArg, externalId) {
      const found = [...checkRuns.values()]
        .toReversed()
        .find((check) => check.headSha === headShaArg && check.externalId === externalId);
      return found ? { id: found.id, url: found.url } : null;
    },

    async finishReviewCheck(outcome) {
      events.push({ kind: "finishReviewCheck", checkRunId: outcome.checkRunId });
    },

    async getCiStatus(headShaArg) {
      events.push({ kind: "getCiStatus", headSha: headShaArg });
      if (ciStatusError != null) throw ciStatusError;
      return (
        ciStatusByHead.get(headShaArg) ?? {
          checkRuns: [],
          checkRunsComplete: true,
          legacyStatuses: [],
        }
      );
    },

    async listFailingActionsJobs(headShaArg) {
      events.push({ kind: "listFailingActionsJobs", headSha: headShaArg });
      const jobs = failingJobsByHead.get(headShaArg) ?? [];
      return { ok: true as const, jobs };
    },

    async downloadActionsJobLogs(jobId) {
      events.push({ kind: "downloadActionsJobLogs", jobId });
      const text = jobLogs.get(jobId);
      if (text == null || text.trim().length === 0) {
        return { ok: false as const, reason: "empty" as const };
      }
      return { ok: true as const, text };
    },

    async listCheckRunAnnotations(checkRunId) {
      events.push({ kind: "listCheckRunAnnotations", checkRunId });
      return [];
    },

    async gitCredentialAuth() {
      events.push({ kind: "gitCredentialAuth" });
      return { token: credentialToken, expiresAtTs: credentialExpiresAtTs };
    },

    async gitCredentialToken() {
      events.push({ kind: "gitCredentialToken" });
      return (await this.gitCredentialAuth()).token;
    },

    async listConversationComments() {
      events.push({ kind: "listConversationComments" });
      const comments = new Map(conversationComments.map((comment) => [comment.id, comment]));
      for (const comment of issueComments.values()) {
        if (comments.has(comment.id)) continue;
        comments.set(comment.id, {
          id: comment.id,
          inReplyToId: null,
          authorLogin: "pr-agent[bot]",
          body: comment.body,
        });
      }
      return [...comments.values()];
    },

    async listInlineReviewComments() {
      events.push({ kind: "listInlineReviewComments" });
      return inlineReviewComments;
    },

    async editReviewComment(commentId, body) {
      events.push({ kind: "editReviewComment", commentId, body });
      if (!reviewCommentBodies.has(commentId)) return false;
      reviewCommentBodies.set(commentId, body);
      return true;
    },

    async getPullRequestBody() {
      events.push({ kind: "getPullRequestBody" });
      return pullRequestBody;
    },

    async getPullRequestBranchInfo() {
      events.push({ kind: "getPullRequestBranchInfo" });
      return pullRequestBranchInfo;
    },

    async publishDescription(_cfg, _payload: DescriptionPayload, _operationMarker?: string) {
      events.push({ kind: "publishDescription" });
      return { prNumber: params.prNumber, titleUpdated: false, bodyUpdated: true };
    },

    async listPushedCommits() {
      events.push({ kind: "listPushedCommits" });
      return pushedCommits;
    },

    async lookupGitHubUser(userId) {
      events.push({ kind: "lookupGitHubUser", userId });
      return githubUsers.get(userId) ?? null;
    },

    isRateLimitCircuitOpen() {
      return rateLimitOpen;
    },
  };

  return {
    surface:
      options?.mutationBoundary == null
        ? surface
        : withPrSurfaceMutationBoundary(surface, options.mutationBoundary),
    controls,
  };
}
