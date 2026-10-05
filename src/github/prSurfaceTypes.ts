import type { PrResource } from "../agentWork/types.js";
import type { Config, GithubReactionContent } from "../settings/index.js";
import type { OperationIntentRow } from "../agentWork/operationIntentRepository.js";
import type { OperationIntentRecovery } from "../agentWork/publishOnce.js";
import type { ReplyTarget } from "../agentWork/types.js";
import type { InstallationToken } from "./appAuth.js";
import type { ReviewCapabilityPolicy } from "./installationCapabilities.js";
import type { CiStatusSourcesResult } from "./ciStatus.js";
import type {
  ListPullRequestFilesLimits,
  ListPullRequestFilesResult,
  PullRequestForFileList,
} from "./listPullRequestFiles.js";
import type { ListCommitCompareFilesResult } from "./compareCommitFiles.js";
import type { DownloadActionsJobLogsResult, ListFailingActionsJobsResult } from "./actionsLogs.js";
import type { ListReviewThreadResolutionResult } from "./reviewThreadResolution.js";
import type { InlineReviewComment, ReviewCheckRunConclusion } from "./reviewPublish.js";
import type { CiCheckRunSnapshot, CiLegacyStatus } from "../review/ci/ciFacts.js";
import type { ReviewThreadComment } from "../review/run/reviewPriorFeedback.js";

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
/** One pull request review comment as GitHub returns it, with bounded pagination. */
export type PrReviewComment = ReviewThreadComment & { readonly authorLogin: string };
export type ListReviewCommentsResult = {
  readonly comments: readonly PrReviewComment[];
  /** True when the provider pagination cap stopped the listing early. */
  readonly truncated: boolean;
};
export type PrReview = {
  readonly id: number;
  readonly userId: number | null;
  readonly authorLogin: string | null;
  readonly body: string | null;
  readonly commitId: string | null;
  readonly htmlUrl: string;
};
export type ReviewCommitStatusParams = {
  readonly state: "success" | "failure" | "error" | "pending";
  readonly description: string;
  readonly targetUrl?: string;
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
  readonly legacyStatusesComplete?: boolean;
  readonly sources?: CiStatusSourcesResult["sources"];
};

export type PrConversationComment = {
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly authorLogin: string;
  readonly body: string;
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

export type PullRequestUpdate = {
  readonly title: string;
  readonly body: string;
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
  readonly decodeResult: (value: unknown) => unknown;
};

/**
 * Durable executions inject this boundary into the PR surface. Read methods do
 * not cross it, so recovery can still inspect GitHub after a lease is lost.
 */
export type PrSurfaceMutationBoundary = {
  readonly signal: AbortSignal;
  readonly run: (mutation: PrSurfaceMutation, mutate: () => Promise<unknown>) => Promise<unknown>;
};

export type CreatePrSurfaceParams = PrResource & {
  readonly cfg: Pick<Config, "github">;
  readonly installationId: number;
  /** Seed token when already minted (strictly fewer mint lookups). */
  readonly installation?: InstallationToken;
  readonly capabilities?: ReviewCapabilityPolicy;
  readonly tokenResolver?: () => Promise<InstallationToken>;
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
  updatePullRequest(
    update: PullRequestUpdate,
    operationMarker?: string,
  ): Promise<{ readonly prNumber: number }>;
};

/** Read-only methods remain callable while a leased execution is fenced. */
export type PrSurfaceReadMethods = PrResource & {
  readonly capabilities?: ReviewCapabilityPolicy;
  getHead(): Promise<PullRequestHeadResolution>;
  getHeadSha(): Promise<string>;
  getBotLogin(): Promise<string>;
  findProgressComment(sentinel: string): Promise<IssueCommentRef | null>;
  resolveProgressComment(
    sentinel: string,
    hintCommentId?: number | null,
  ): Promise<IssueCommentRef | null>;
  listReviewComments(): Promise<ListReviewCommentsResult>;
  listPullRequestReviews(): Promise<readonly PrReview[]>;
  listInlineReviewThreads(): Promise<ListReviewThreadResolutionResult>;
  listChangedFiles(
    caps: ListPullRequestFilesLimits,
    pullRequest?: PullRequestForFileList,
  ): Promise<ListPullRequestFilesResult>;
  listCommitCompareFiles(base: string, head: string): Promise<ListCommitCompareFilesResult>;
  getLabels(): Promise<readonly string[]>;
  findReviewCheck(headSha: string, externalId: string): Promise<CheckRef | null>;
  getCiStatus(headSha: string): Promise<CiStatusSnapshot>;
  /** Independent, complete status evidence. Legacy adapters may omit it. */
  getReviewCommitStatuses?(headSha: string): Promise<readonly CiLegacyStatus[]>;
  listPullsForHead(headSha: string): Promise<readonly { readonly number: number }[]>;
  listFailingActionsJobs(headSha: string): Promise<ListFailingActionsJobsResult>;
  downloadActionsJobLogs(jobId: number): Promise<DownloadActionsJobLogsResult>;
  gitCredentialAuth(): Promise<{ readonly token: string; readonly expiresAtTs: number }>;
  listConversationComments(): Promise<readonly PrConversationComment[]>;
  listPushedCommits(): Promise<readonly PushedCommitSummary[]>;
  lookupGitHubUser(userId: number): Promise<GithubUserProfile | null>;
};

export type PrSurface = PrSurfaceReadMethods & PrSurfaceMutationMethods;
