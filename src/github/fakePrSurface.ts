import type { ReplyTarget } from "../commands/replyTarget.js";
import type { ListPullRequestFilesLimits, PullRequestForFileList } from "./listPullRequestFiles.js";
import type { ReviewThreadResolution } from "./reviewThreadResolution.js";
import type { GithubReactionContent } from "../settings/index.js";
import type {
  AcknowledgementTarget,
  CreatePrSurfaceParams,
  PrSurface,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";

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
      readonly knownExisting?: { readonly id: number; readonly url?: string } | null;
    }
  | { readonly kind: "listPullRequestReviewComments" }
  | {
      readonly kind: "setReviewCommitStatus";
      readonly headSha: string;
      readonly status: { readonly state: string; readonly description: string; readonly targetUrl?: string };
    }
  | { readonly kind: "fetchPriorInlineFeedback"; readonly botUserId: number }
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
  | { readonly kind: "gitCredentialToken" };

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
      readonly threadUrl: string;
    }>,
  ) => void;
};

type FakePrSurfaceOptions = {
  readonly headSha?: string;
  readonly pullRequest?: PullRequestForFileList;
  readonly labels?: readonly string[];
  readonly credentialToken?: string;
  readonly rateLimitOpen?: boolean;
};

let nextCommentId = 1;
let nextReviewId = 1;
let nextCheckRunId = 1;

function defaultPullRequest(headSha: string): PullRequestForFileList {
  return {
    additions: 0,
    deletions: 0,
    changed_files: 0,
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

  let headSha = options?.headSha ?? "fake-head-sha";
  let pullRequest = options?.pullRequest ?? defaultPullRequest(headSha);
  const issueComments = new Map<
    number,
    { readonly id: number; readonly body: string; readonly url?: string }
  >();
  const progressBySentinel = new Map<string, number>();
  let labels = [...(options?.labels ?? [])];
  let rateLimitOpen = options?.rateLimitOpen ?? false;
  let credentialToken = options?.credentialToken ?? "fake-git-token";
  const threads = new Map<number, ReviewThreadResolution>();
  const checkRuns = new Map<number, { readonly id: number; readonly url: string | null }>();
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
    readonly threadUrl: string;
  }> = [];
  let reviewComments: Array<{ path: string; line: number; id: number; url: string }> = [];

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

    async setAcknowledgementReaction(targets, kind) {
      events.push({ kind: "setAcknowledgementReaction", targets, reaction: kind });
      reactions.push({ targets: [...targets], kind });
    },

    async replyAt(target, body) {
      events.push({ kind: "replyAt", target, body });
      replies.push({ target, body });
      const commentId = nextCommentId++;
      issueComments.set(commentId, {
        id: commentId,
        body,
        url: `https://github.com/${params.owner}/${params.repo}/issues/${params.prNumber}#issuecomment-${commentId}`,
      });
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

    async fetchPriorInlineFeedback(botUserId) {
      events.push({ kind: "fetchPriorInlineFeedback", botUserId });
      return priorInlineFeedback;
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
      return {
        reviewId,
        reviewUrl: `https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}#pullrequestreview-${reviewId}`,
      };
    },

    async listInlineReviewThreads() {
      events.push({ kind: "listInlineReviewThreads" });
      return { byRootCommentId: new Map(threads), status: "ok" as const };
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
      return {
        files: [],
        truncated: false,
        omittedCountLowerBound: 0,
        totalChanges: 0,
        headSha,
      };
    },

    async listCommitCompareFiles(base, head) {
      events.push({ kind: "listCommitCompareFiles", base, head });
      return { files: [], truncated: false };
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
      checkRuns.set(id, { id, url });
      return { id, url };
    },

    async finishReviewCheck(outcome) {
      events.push({ kind: "finishReviewCheck", checkRunId: outcome.checkRunId });
    },

    async getCiStatus(headShaArg) {
      events.push({ kind: "getCiStatus", headSha: headShaArg });
      return { checkRuns: [], legacyStatuses: [] };
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

    async gitCredentialToken() {
      events.push({ kind: "gitCredentialToken" });
      return credentialToken;
    },

    isRateLimitCircuitOpen() {
      return rateLimitOpen;
    },
  };

  return { surface, controls };
}
