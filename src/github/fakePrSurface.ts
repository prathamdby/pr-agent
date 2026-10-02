import type { ReplyTarget } from "../agentWork/types.js";
import type {
  ListPullRequestFilesLimits,
  ListPullRequestFilesResult,
  PullRequestBranchInfo,
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
  PrReview,
  PrReviewComment,
  PrSurface,
  PrSurfaceMutationBoundary,
  PullRequestUpdate,
  PushedCommitSummary,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
import { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.js";
import type { CiCheckRunSnapshot, CiLegacyStatus } from "../review/ci/ciFacts.js";
import type { ReviewCheckRunConclusion } from "./reviewPublish.js";

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
  | { readonly kind: "listReviewComments" }
  | { readonly kind: "listPullRequestReviews" }
  | {
      readonly kind: "setReviewCommitStatus";
      readonly headSha: string;
      readonly status: {
        readonly state: string;
        readonly description: string;
        readonly targetUrl?: string;
      };
    }
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
  | {
      readonly kind: "finishReviewCheck";
      readonly checkRunId: number;
      readonly conclusion: ReviewCheckRunConclusion;
    }
  | { readonly kind: "getCiStatus"; readonly headSha: string }
  | { readonly kind: "listPullsForHead"; readonly headSha: string }
  | { readonly kind: "listFailingActionsJobs"; readonly headSha: string }
  | { readonly kind: "downloadActionsJobLogs"; readonly jobId: number }
  | { readonly kind: "gitCredentialAuth" }
  | { readonly kind: "listConversationComments" }
  | { readonly kind: "editReviewComment"; readonly commentId: number; readonly body: string }
  | {
      readonly kind: "updatePullRequest";
      readonly update: PullRequestUpdate;
      readonly operationMarker?: string;
    }
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
  readonly setCredentialToken: (token: string) => void;
  readonly setCredentialAuth: (auth: {
    readonly token: string;
    readonly expiresAtTs: number;
  }) => void;
  readonly setCiStatus: (
    headSha: string,
    status: {
      readonly checkRuns: readonly CiCheckRunSnapshot[];
      readonly checkRunsComplete?: boolean;
      readonly legacyStatuses: readonly CiLegacyStatus[];
    },
  ) => void;
  readonly setCiStatusError: (error: unknown) => void;
  readonly setPullsForHead: (
    headSha: string,
    pulls: readonly { readonly number: number }[],
  ) => void;
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
  readonly setReviewComments: (comments: readonly PrReviewComment[]) => void;
  readonly setPullRequestReviews: (reviews: readonly PrReview[]) => void;
  readonly setConversationComments: (comments: readonly PrConversationComment[]) => void;
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
  readonly mutationBoundary?: PrSurfaceMutationBoundary;
};

let nextCommentId = 1;
let nextReviewId = 1;
let nextCheckRunId = 1;

function defaultPullRequest(headSha: string): PullRequestForFileList {
  return {
    title: "",
    body: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    state: "open",
    merged: false,
    merged_at: null,
    head: { sha: headSha, ref: "branch", repo: { full_name: "o/r" } },
    base: { repo: { full_name: "o/r" } },
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
  let credentialToken = options?.credentialToken ?? "fake-git-token";
  let credentialExpiresAtTs = Date.now() + 3_600_000;
  let ciStatusError: unknown;
  const pullsByHead = new Map<string, readonly { readonly number: number }[]>();
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
  let reviewComments: PrReviewComment[] = [];
  let seededReviews: PrReview[] = [];
  let conversationComments: PrConversationComment[] = [];
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
      pullRequest = { ...pullRequest, head: { ...pullRequest.head, sha: next } };
    },
    setPullRequest(next) {
      pullRequest = next;
      if (next.head?.sha) headSha = next.head.sha;
    },
    setLabels(next) {
      labels = [...next];
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
        checkRunsComplete: status.checkRunsComplete ?? true,
        legacyStatuses: [...status.legacyStatuses],
      });
      ciStatusError = undefined;
    },
    setCiStatusError(error) {
      ciStatusError = error;
    },
    setPullsForHead(headShaArg, pulls) {
      pullsByHead.set(headShaArg, pulls);
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
    setReviewComments(next) {
      reviewComments = [...next];
    },
    setPullRequestReviews(next) {
      seededReviews = [...next];
    },
    setConversationComments(next) {
      conversationComments = [...next];
    },
    setPullRequestBody(body) {
      pullRequest = { ...pullRequest, body };
    },
    setPullRequestBranchInfo(info) {
      const baseRepo = pullRequest.base?.repo?.full_name ?? "o/r";
      pullRequest = {
        ...pullRequest,
        head: {
          ...pullRequest.head,
          ref: info.headRef,
          repo: { full_name: info.sameRepo ? baseRepo : `fork/${baseRepo}` },
        },
        base: { ...pullRequest.base, repo: { full_name: baseRepo } },
      };
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
        reviewComments.push({
          id: commentId,
          inReplyToId: target.inReplyToCommentId,
          pullRequestReviewId: null,
          userId: null,
          authorLogin: "pr-agent[bot]",
          authorAssociation: null,
          body,
          path: null,
          line: null,
          originalLine: null,
          htmlUrl: "",
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

    async listReviewComments() {
      events.push({ kind: "listReviewComments" });
      return { comments: [...reviewComments], truncated: false };
    },

    async listPullRequestReviews() {
      events.push({ kind: "listPullRequestReviews" });
      return [
        ...seededReviews,
        ...publishedThreadBatches.map((batch): PrReview => ({
          id: batch.id,
          userId: null,
          authorLogin: batch.authorLogin,
          body: batch.review.body,
          commitId: batch.review.commitId ?? null,
          htmlUrl: batch.url,
        })),
      ];
    },

    async setReviewCommitStatus(headShaArg, status) {
      events.push({ kind: "setReviewCommitStatus", headSha: headShaArg, status });
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
      events.push({
        kind: "finishReviewCheck",
        checkRunId: outcome.checkRunId,
        conclusion: outcome.conclusion,
      });
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

    async listPullsForHead(headShaArg) {
      events.push({ kind: "listPullsForHead", headSha: headShaArg });
      return pullsByHead.get(headShaArg) ?? [];
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

    async gitCredentialAuth() {
      events.push({ kind: "gitCredentialAuth" });
      return { token: credentialToken, expiresAtTs: credentialExpiresAtTs };
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

    async editReviewComment(commentId, body) {
      events.push({ kind: "editReviewComment", commentId, body });
      if (!reviewCommentBodies.has(commentId)) return false;
      reviewCommentBodies.set(commentId, body);
      return true;
    },

    async updatePullRequest(update, operationMarker) {
      events.push({
        kind: "updatePullRequest",
        update,
        ...(operationMarker != null ? { operationMarker } : {}),
      });
      pullRequest = { ...pullRequest, title: update.title, body: update.body };
      return { prNumber: params.prNumber };
    },

    async listPushedCommits() {
      events.push({ kind: "listPushedCommits" });
      return pushedCommits;
    },

    async lookupGitHubUser(userId) {
      events.push({ kind: "lookupGitHubUser", userId });
      return githubUsers.get(userId) ?? null;
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
