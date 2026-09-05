import type { Config } from "../config.js";
import type { DescriptionPayload } from "../agent/description/descriptionSchema.js";
import type { OperationIntentRow } from "../agentWork/operationIntentRepository.js";
import type { OperationIntentRecovery } from "../agentWork/withOperationIntent.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import type { InstallationToken } from "./appAuth.js";
import type {
  ListPullRequestFilesLimits,
  ListPullRequestFilesResult,
  PullRequestForFileList,
} from "./listPullRequestFiles.js";
import type { ListCommitCompareFilesResult } from "./compareCommitFiles.js";
import type { DownloadActionsJobLogsResult, ListFailingActionsJobsResult } from "./actionsLogs.js";
import type { ListReviewThreadResolutionResult } from "./reviewThreadResolution.js";
import type { InlineReviewComment, ReviewCheckRunConclusion } from "./reviewPublish.js";
import type { RateLimitCircuit } from "./rateLimitCircuit.js";
import type {
  CiCheckAnnotation,
  CiCheckRunSnapshot,
  CiLegacyStatus,
} from "../review/ci/ciSummaryTypes.js";
import type { BotFindingThread, ReviewThreadReply } from "../review/run/reviewPriorFeedback.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";
import type { GithubReactionContent } from "../settings/index.js";

export type AcknowledgementTarget =
  | { readonly kind: "pr"; readonly prNumber: number }
  | { readonly kind: "issueComment"; readonly commentId: number }
  | { readonly kind: "reviewComment"; readonly commentId: number };

export type PullRequestHeadResolution = {
  readonly headSha: string;
  readonly pullRequest: PullRequestForFileList;
};

export type PostedReply = { readonly commentId: number };
export type IssueCommentRef = {
  readonly id: number;
  readonly url: string;
  readonly body?: string;
};
export type ProgressCommentUpsert = { readonly id: number; readonly updated: boolean };
export type PublishedReviewCommentRef = {
  readonly path: string;
  readonly line: number;
  readonly id: number;
  readonly url: string;
};
export type ListPullRequestReviewCommentsResult = {
  readonly comments: readonly PublishedReviewCommentRef[];
  readonly truncated: boolean;
};
export type ReviewCommitStatusParams = {
  readonly state: "success" | "failure" | "error";
  readonly description: string;
  readonly targetUrl?: string;
};
export type PriorInlineFeedbackEntry = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly botTitleSnippet: string;
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
  readonly replies?: readonly ReviewThreadReply[];
  readonly threadUrl: string;
};
export type ThreadBatchReview = {
  readonly body: string;
  readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  readonly comments?: readonly InlineReviewComment[];
  readonly commitId?: string;
};
export type PublishedBatch = { readonly reviewId: number; readonly reviewUrl: string };
export type CheckRef = { readonly id: number; readonly url: string | null };
export type ReviewCheckOutcome = {
  readonly checkRunId: number;
  readonly conclusion: ReviewCheckRunConclusion;
  readonly summary: string;
  readonly detailsUrl?: string;
  readonly name?: string;
};
export type CiStatusSnapshot = {
  readonly checkRuns: readonly CiCheckRunSnapshot[];
  /** False when the provider pagination cap prevented a complete check-run view. */
  readonly checkRunsComplete?: boolean;
  readonly legacyStatuses: readonly CiLegacyStatus[];
};

export type PrConversationComment = {
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly authorLogin: string;
  readonly body: string;
};

export type PullRequestBranchInfo = {
  readonly headRef: string;
  readonly sameRepo: boolean;
};

export type PushedCommitSummary = {
  readonly sha: string;
  readonly subject: string;
};

export type GithubUserProfile = {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly type: string;
};

export type PublishDescriptionSurfaceResult = {
  readonly prNumber: number;
  readonly bodyUpdated: boolean;
  readonly titleUpdated?: boolean;
};

export type ReviewCommentParentNode = {
  readonly id: number;
  readonly inReplyToId: number | null;
};

/**
 * Stable metadata for one PR-surface mutation. The boundary stores this before
 * invoking the external call and reconciles its result afterward.
 */
export type PrSurfaceMutation = {
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: Record<string, unknown>;
  readonly recover?: (
    intent: OperationIntentRow,
    publishRecordId: string | null,
  ) => Promise<OperationIntentRecovery<unknown>>;
  readonly allowsUndefinedResult?: boolean;
};

/**
 * Durable executions inject this boundary into the PR surface. Read methods do
 * not cross it, so recovery can still inspect GitHub after a lease is lost.
 */
export type PrSurfaceMutationBoundary = {
  readonly signal: AbortSignal;
  readonly run: <T>(mutation: PrSurfaceMutation, mutate: () => Promise<T>) => Promise<T>;
};

export type CreatePrSurfaceParams = {
  readonly cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** Seed token when already minted (strictly fewer mint lookups). */
  readonly installation?: InstallationToken;
  readonly rateLimitCircuit?: RateLimitCircuit;
  readonly mutationBoundary?: PrSurfaceMutationBoundary;
};

/** Methods that cross the PR-surface mutation boundary. Keep this type exhaustive. */
export type PrSurfaceMutationMethods = {
  setAcknowledgementReaction(
    targets: readonly AcknowledgementTarget[],
    kind: GithubReactionContent,
  ): Promise<void>;
  replyAt(target: ReplyTarget, body: string): Promise<PostedReply>;
  upsertProgressComment(
    body: string,
    sentinel: string,
    knownExisting?: IssueCommentRef | null,
  ): Promise<ProgressCommentUpsert>;
  editComment(commentId: number, body: string): Promise<void>;
  setReviewCommitStatus(headSha: string, params: ReviewCommitStatusParams): Promise<void>;
  publishThreadBatch(review: ThreadBatchReview): Promise<PublishedBatch>;
  resolveInlineReviewThread(threadId: string): Promise<void>;
  setLabels(labels: readonly string[]): Promise<void>;
  startReviewCheck(headSha: string, externalId: string, summary?: string): Promise<CheckRef>;
  finishReviewCheck(outcome: ReviewCheckOutcome): Promise<void>;
  editReviewComment(commentId: number, body: string): Promise<boolean>;
  publishDescription(
    cfg: Pick<Config, "features">,
    payload: DescriptionPayload,
    operationMarker?: string,
  ): Promise<PublishDescriptionSurfaceResult>;
};

/** Read-only methods remain callable while a leased execution is fenced. */
export type PrSurfaceReadMethods = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  getHead(): Promise<PullRequestHeadResolution>;
  getHeadSha(): Promise<string>;
  getBotLogin?(): Promise<string>;
  findProgressComment(sentinel: string): Promise<IssueCommentRef | null>;
  resolveProgressComment(
    sentinel: string,
    hintCommentId?: number | null,
  ): Promise<IssueCommentRef | null>;
  listPullRequestReviewComments(): Promise<ListPullRequestReviewCommentsResult>;
  fetchPriorInlineFeedback(
    botUserId: number,
    currentLens: AnyReviewLens,
    maintainerDecisionAssociations?: ReadonlySet<string>,
  ): Promise<readonly PriorInlineFeedbackEntry[]>;
  fetchBotFindingThreads(
    botUserId: number,
    publishRecordLenses?: ReadonlyMap<number, AnyReviewLens>,
    maintainerDecisionAssociations?: ReadonlySet<string>,
  ): Promise<readonly BotFindingThread[]>;
  fetchReviewCommentParentGraph(): Promise<readonly ReviewCommentParentNode[]>;
  findPublishedThreadBatch?(marker: string, commitId?: string): Promise<PublishedBatch | null>;
  listInlineReviewThreads(): Promise<ListReviewThreadResolutionResult>;
  listChangedFiles(
    caps: ListPullRequestFilesLimits,
    pullRequest?: PullRequestForFileList,
  ): Promise<ListPullRequestFilesResult>;
  listCommitCompareFiles(base: string, head: string): Promise<ListCommitCompareFilesResult>;
  getLabels(): Promise<readonly string[]>;
  findReviewCheck?(headSha: string, externalId: string): Promise<CheckRef | null>;
  getCiStatus(headSha: string): Promise<CiStatusSnapshot>;
  listFailingActionsJobs(headSha: string): Promise<ListFailingActionsJobsResult>;
  downloadActionsJobLogs(jobId: number): Promise<DownloadActionsJobLogsResult>;
  listCheckRunAnnotations(checkRunId: number): Promise<readonly CiCheckAnnotation[]>;
  gitCredentialAuth(): Promise<{ readonly token: string; readonly expiresAtTs: number }>;
  listConversationComments(): Promise<readonly PrConversationComment[]>;
  listInlineReviewComments(): Promise<readonly PrConversationComment[]>;
  getPullRequestBody(): Promise<string | null>;
  getPullRequestBranchInfo(): Promise<PullRequestBranchInfo>;
  listPushedCommits(): Promise<readonly PushedCommitSummary[]>;
  lookupGitHubUser(userId: number): Promise<GithubUserProfile | null>;
  isRateLimitCircuitOpen(): boolean;
};

export type PrSurface = PrSurfaceReadMethods & PrSurfaceMutationMethods;
