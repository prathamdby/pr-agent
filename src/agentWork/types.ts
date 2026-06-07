import type { Config } from "../config.js";
import type { CodeAnchor } from "../agent/askRunTypes.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { WorkSource } from "../review/reviewSchema.js";
import type { ReplyTarget } from "../commands/replyTarget.js";

type WorkType = "review" | "ask" | "description" | "fix";
export type WorkStatus = "queued" | "running" | "superseded" | "cancelled" | "completed" | "failed";

export type WebhookHeaders = {
  readonly delivery?: string;
  readonly event?: string;
  readonly rawBody: Buffer;
};

export type PrRef = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly installationId: number;
  /** Commit SHA, or DEFERRED_HEAD_SHA for worker-side pulls.get resolution */
  readonly headSha: string;
  /** GitHub webhook repository.size, in KB, captured at intake time when available. */
  readonly repositorySizeKb?: number;
};

export type AckTarget =
  | { readonly kind: "pr"; readonly prNumber: number }
  | { readonly kind: "issueComment"; readonly commentId: number }
  | { readonly kind: "reviewComment"; readonly commentId: number };

export type JobCorrelation = {
  readonly webhookEventId?: string;
  readonly delivery?: string;
};

export type AckJobData = JobCorrelation & {
  readonly kind: "ack";
  readonly workItemId?: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly targets: readonly AckTarget[];
  readonly progress?: {
    readonly lens: ReviewMode;
    readonly headSha: string;
    readonly source: WorkSource;
  };
  readonly reply?: {
    readonly target: ReplyTarget;
    readonly body: string;
  };
  readonly commenterId?: number;
};

export type ReviewJobData = JobCorrelation & {
  readonly kind: "review";
  readonly workItemId: string;
};

export type AskJobData = JobCorrelation & {
  readonly kind: "ask";
  readonly workItemId: string;
};

export type DescriptionJobData = JobCorrelation & {
  readonly kind: "description";
  readonly workItemId: string;
};

export type FixJobData = JobCorrelation & {
  readonly kind: "fix";
  readonly workItemId: string;
};

export type ReviewWorkPayload = {
  readonly mode: ReviewMode;
  readonly source: WorkSource;
  readonly repositorySizeKb?: number;
  readonly userSupplement?: string;
  readonly commenterId?: number;
  /** Set when the run finished but structured publish did not succeed */
  readonly publishDegraded?: boolean;
  /** Set on a one-time replacement run after stale head at publish time */
  readonly staleHeadRescheduled?: boolean;
  /** Replacement work item id persisted on the parent before enqueue (idempotent reschedule) */
  readonly staleHeadReplacementWorkItemId?: string;
  /** Set on the parent after replacement ack/review jobs are enqueued */
  readonly staleHeadReplacementEnqueued?: boolean;
};

export type AskWorkPayload = {
  readonly question: string;
  readonly replyTarget: ReplyTarget;
  readonly repositorySizeKb?: number;
  readonly codeAnchor?: CodeAnchor;
  readonly commenterId?: number;
  readonly commentId: number;
};

export type DescriptionWorkPayload = {
  readonly source: WorkSource;
  readonly repositorySizeKb?: number;
  readonly userSupplement?: string;
  readonly commenterId?: number;
};

export type FixTargetSelector =
  | {
      readonly kind: "inline";
      readonly inlineReviewCommentId: number;
    }
  | {
      readonly kind: "all";
    };

export type FixPublishReplyState = {
  readonly commits: readonly {
    readonly sha: string;
    readonly message: string;
  }[];
  readonly skipped: readonly {
    readonly target: {
      readonly severity: "P0" | "P1" | "P2";
      readonly filePath: string;
      readonly startLine: number;
      readonly title: string;
    };
    readonly reason: string;
  }[];
  readonly changedPaths: readonly string[];
};

export type FixPublishCheckpoint =
  | {
      readonly kind: "direct";
      readonly headSha: string;
      readonly replyBody: string;
      readonly replyPosted?: boolean;
    }
  | {
      readonly kind: "fallbackBranch";
      readonly headSha: string;
      readonly branch: string;
      readonly baseOwner: string;
      readonly baseRepo: string;
      readonly baseRef: string;
      readonly replyState: FixPublishReplyState;
    }
  | {
      readonly kind: "fallback";
      readonly headSha: string;
      readonly replyBody: string;
      readonly replyPosted?: boolean;
    };

export type FixWorkPayload = {
  readonly selector: FixTargetSelector;
  readonly replyTarget: ReplyTarget;
  readonly repositorySizeKb?: number;
  readonly commenterId?: number;
  readonly commenterLogin?: string;
  readonly commandCommentId: number;
  readonly publishCheckpoint?: FixPublishCheckpoint;
};

export type AgentWorkItem = PrRef & {
  readonly id: string;
  readonly webhookEventId: string | null;
  readonly type: WorkType;
  readonly source: WorkSource;
  readonly status: WorkStatus;
  readonly reviewLens: ReviewMode | null;
  readonly resourceKey: string;
  readonly attemptCount: number;
  readonly payload: ReviewWorkPayload | AskWorkPayload | DescriptionWorkPayload | FixWorkPayload;
  readonly cancelRequestedAt: Date | null;
};

export type AgentWorkItemCore = Omit<AgentWorkItem, "payload">;

export type QueueConfig = Pick<
  Config,
  | "queueRetryLimit"
  | "queueRetryDelaySeconds"
  | "queueRetryDelayMaxSeconds"
  | "queueExpireInSeconds"
  | "queueHeartbeatSeconds"
  | "queuePollingIntervalSeconds"
  | "queueRetentionSeconds"
  | "queueDeleteAfterSeconds"
  | "installationGroupConcurrency"
>;

export function prResourceKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

export function reviewSingletonKey(resourceKey: string, lens: ReviewMode): string {
  return `${resourceKey}:${lens}`;
}

export function descriptionSingletonKey(resourceKey: string): string {
  return `${resourceKey}:description`;
}

export function fixSingletonKey(resourceKey: string): string {
  return `${resourceKey}:fix`;
}

export function installationGroupId(installationId: number): string {
  return String(installationId);
}
