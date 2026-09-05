import type { Config } from "../config.js";
import type { CodeAnchor } from "../agent/ask/askRunTypes.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { WorkSource } from "../review/reviewSchema.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import type { ReviewCancelAttribution } from "../settings/reviewConstants.js";

export type WorkType = "review" | "ask" | "description" | "triage" | "verification";
export type WorkStatus = "queued" | "running" | "superseded" | "cancelled" | "completed" | "failed";

export const ACTIVE_WORK_STATUSES = ["queued", "running"] as const satisfies readonly WorkStatus[];

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
  /** Cancelled notice for the progress stub plus check-run completion for each cancelled review. */
  readonly cancelProgress?: {
    readonly workItemId: string;
    /** Absent on stale pre-deploy ack jobs; reader falls back to workItemId. */
    readonly cancelledWorkItemIds?: readonly string[];
    readonly attribution: ReviewCancelAttribution;
  };
  /** Terminal acknowledgement for a queued/running triage cancelled by PR close. */
  readonly cancelTriage?: {
    readonly workItemId: string;
    /** Absent on stale pre-deploy ack jobs; reader falls back to workItemId. */
    readonly cancelledWorkItemIds?: readonly string[];
    readonly attribution: ReviewCancelAttribution;
    readonly targets: readonly AckTarget[];
    readonly replyTarget: ReplyTarget;
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

/** Fire-and-forget CI cell refresh after workflow_run / check_suite completed (ADR 0018). */
export type CiRefreshJobData = JobCorrelation & {
  readonly kind: "ci_refresh";
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  /** 0 at intake. Each retain hop increments until the cap. */
  readonly attempt: number;
};

export type StaleHeadReplacementState = "pending-enqueue" | "enqueued";

/** Parent-persisted stale-head replacement. Identity and lifecycle stay coupled. */
export type StaleHeadReplacement = {
  readonly replacementWorkItemId: string;
  readonly state: StaleHeadReplacementState;
};

export type ReviewWorkPayload = {
  readonly mode: ReviewMode;
  readonly source: WorkSource;
  readonly repositorySizeKb?: number;
  readonly userSupplement?: string;
  readonly commenterId?: number;
  readonly ackTargets?: readonly AckTarget[];
  /** Set when the run finished but structured publish did not succeed */
  readonly publishDegraded?: boolean;
  /** Set on the one-time replacement run after stale-head detection. */
  readonly staleHeadRescheduled?: boolean;
  /** Parent-owned replacement lifecycle. Absent when this review has no replacement. */
  readonly staleHeadReplacement?: StaleHeadReplacement;
  /** Set when the review is cancelled (slash or merge); drives the cancelled progress notice. */
  readonly cancelAttribution?: ReviewCancelAttribution;
};

export type AskWorkPayload = {
  readonly question: string;
  readonly replyTarget: ReplyTarget;
  readonly repositorySizeKb?: number;
  readonly codeAnchor?: CodeAnchor;
  readonly commenterId?: number;
  readonly commentId: number;
  readonly ackTargets?: readonly AckTarget[];
};

export type DescriptionWorkPayload = {
  readonly source: WorkSource;
  readonly repositorySizeKb?: number;
  readonly userSupplement?: string;
  readonly commenterId?: number;
  readonly ackTargets?: readonly AckTarget[];
};

export type TriageScope = "all" | "thread";

/** Apply is the existing `/triage` path. Preview and bulk are the issue 542 pair. */
export type TriageMode = "apply" | "preview" | "bulk";

export type TriageWorkPayload = {
  readonly source: "slash";
  readonly repositorySizeKb?: number;
  readonly commenterId?: number;
  readonly commentId: number;
  readonly scope: TriageScope;
  /** Absent on rows written before preview/bulk. Readers treat missing as `apply`. */
  readonly mode?: TriageMode;
  readonly excludeThreadRootCommentIds?: readonly number[];
  readonly threadAnchorCommentId?: number;
  readonly needsThreadRootResolution?: boolean;
  readonly replyTarget: ReplyTarget;
  readonly publishDegraded?: boolean;
  readonly ackTargets?: readonly AckTarget[];
  /** Set when close/merge intake cancels the triage work item. */
  readonly cancelAttribution?: ReviewCancelAttribution;
};

export function triageMode(payload: Pick<TriageWorkPayload, "mode">): TriageMode {
  return payload.mode ?? "apply";
}

export type VerificationWorkPayload = {
  readonly source: WorkSource;
  readonly repositorySizeKb?: number;
  readonly pushBeforeSha?: string;
  readonly ackTargets?: readonly AckTarget[];
  /** Set when the run finished but structured publish did not succeed */
  readonly publishDegraded?: boolean;
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
  readonly source: WorkSource;
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

export function installationGroupId(installationId: number): string {
  return String(installationId);
}
