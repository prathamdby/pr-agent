import type { Config } from "../config.js";
import type { CodeAnchor } from "../agent/ask/askRunTypes.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { WorkSource } from "../review/reviewSchema.js";
import type { ReplyTarget } from "../commands/replyTarget.js";

export type WorkType = "review" | "ask" | "description" | "triage" | "verification";
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

export type TriageJobData = JobCorrelation & {
  readonly kind: "triage";
  readonly workItemId: string;
};

export type VerificationJobData = JobCorrelation & {
  readonly kind: "verification";
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

export type TriageScope = "all" | "thread";

export type TriageWorkPayload = {
  readonly source: "slash";
  readonly repositorySizeKb?: number;
  readonly commenterId?: number;
  readonly commentId: number;
  readonly scope: TriageScope;
  readonly threadAnchorCommentId?: number;
  readonly needsThreadRootResolution?: boolean;
  readonly replyTarget: ReplyTarget;
  readonly publishDegraded?: boolean;
};

export type VerificationWorkPayload = {
  readonly source: "auto";
  readonly repositorySizeKb?: number;
  readonly pushBeforeSha?: string;
};

type WorkItemBase = PrRef & {
  readonly id: string;
  readonly webhookEventId: string | null;
  readonly status: WorkStatus;
  readonly resourceKey: string;
  readonly attemptCount: number;
  readonly cancelRequestedAt: Date | null;
};

export type ReviewWorkItem = WorkItemBase & {
  readonly type: "review";
  readonly source: WorkSource;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
};

export type AskWorkItem = WorkItemBase & {
  readonly type: "ask";
  readonly source: "slash";
  readonly reviewLens: null;
  readonly payload: AskWorkPayload;
};

export type DescriptionWorkItem = WorkItemBase & {
  readonly type: "description";
  readonly source: WorkSource;
  readonly reviewLens: null;
  readonly payload: DescriptionWorkPayload;
};

export type TriageWorkItem = WorkItemBase & {
  readonly type: "triage";
  readonly source: "slash";
  readonly reviewLens: null;
  readonly payload: TriageWorkPayload;
};

export type VerificationWorkItem = WorkItemBase & {
  readonly type: "verification";
  readonly source: "auto";
  readonly reviewLens: null;
  readonly payload: VerificationWorkPayload;
};

export type AgentWorkItem =
  | ReviewWorkItem
  | AskWorkItem
  | DescriptionWorkItem
  | TriageWorkItem
  | VerificationWorkItem;

type ReviewWorkItemCore = Omit<ReviewWorkItem, "payload">;
type AskWorkItemCore = Omit<AskWorkItem, "payload">;
type DescriptionWorkItemCore = Omit<DescriptionWorkItem, "payload">;
type TriageWorkItemCore = Omit<TriageWorkItem, "payload">;
type VerificationWorkItemCore = Omit<VerificationWorkItem, "payload">;

export type AgentWorkItemCore =
  | ReviewWorkItemCore
  | AskWorkItemCore
  | DescriptionWorkItemCore
  | TriageWorkItemCore
  | VerificationWorkItemCore;

export function isWorkItemType<T extends WorkType>(
  item: AgentWorkItem,
  type: T,
): item is Extract<AgentWorkItem, { type: T }>;
export function isWorkItemType<T extends WorkType>(
  item: AgentWorkItemCore,
  type: T,
): item is Extract<AgentWorkItemCore, { type: T }>;
export function isWorkItemType(item: AgentWorkItem | AgentWorkItemCore, type: WorkType): boolean {
  return item.type === type;
}

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

export function triageSingletonKey(resourceKey: string): string {
  return `${resourceKey}:triage`;
}

export function verificationSingletonKey(resourceKey: string): string {
  return `${resourceKey}:verification`;
}

export function installationGroupId(installationId: number): string {
  return String(installationId);
}
