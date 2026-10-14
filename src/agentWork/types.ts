import type { Config, ReviewCancelAttribution } from "../settings/index.js";
import {
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/queueConstants.js";
import type { CodeAnchor } from "../agent/ask/askRunTypes.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { WorkSource } from "../review/reviewSchema.js";

export type WorkType = "review" | "ask" | "description" | "triage" | "verification";

export const WORK_QUEUES = {
  review: REVIEW_QUEUE,
  ask: ASK_QUEUE,
  description: DESCRIPTION_QUEUE,
  triage: TRIAGE_QUEUE,
  verification: VERIFICATION_QUEUE,
} as const satisfies Record<WorkType, string>;
export const WORK_STATUSES = [
  "queued",
  "running",
  "superseded",
  "cancelled",
  "completed",
  "failed",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const ACTIVE_WORK_STATUSES = ["queued", "running"] as const satisfies readonly WorkStatus[];

export type WebhookHeaders = {
  readonly delivery?: string;
  readonly event?: string;
  readonly rawBody: Buffer;
};

export type PrResource = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

export type ReplyTarget =
  | { readonly kind: "prConversation"; readonly prNumber: number }
  | {
      readonly kind: "inlineReviewThread";
      readonly prNumber: number;
      readonly inReplyToCommentId: number;
    };

export type PrRef = PrResource & {
  readonly installationId: number;
  readonly headSha: string;
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
  readonly awaitingApproval?: true;
  readonly closedApproval?: ReviewCancelAttribution;
  readonly progress?: {
    readonly lens: ReviewMode;
    readonly headSha: string;
    readonly source: WorkSource;
  };
  readonly cancelProgress?: {
    readonly workItemId: string;
    readonly cancelledWorkItemIds?: readonly string[];
    readonly attribution: ReviewCancelAttribution;
  };
  readonly cancelTriage?: {
    readonly workItemId: string;
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

export type CiProjectionJobData = JobCorrelation & {
  readonly kind: "ci_projection";
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
};

export type StaleHeadReplacementState = "pending-enqueue" | "enqueued";

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
  readonly publishDegraded?: boolean;
  readonly staleHeadRescheduled?: boolean;
  readonly staleHeadReplacement?: StaleHeadReplacement;
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

export type TriageMode = "apply" | "preview" | "bulk";

export type TriageWorkPayload = {
  readonly source: "slash";
  readonly repositorySizeKb?: number;
  readonly commenterId?: number;
  readonly commentId: number;
  readonly scope: TriageScope;
  readonly mode?: TriageMode;
  readonly excludeThreadRootCommentIds?: readonly number[];
  readonly threadAnchorCommentId?: number;
  readonly needsThreadRootResolution?: boolean;
  readonly replyTarget: ReplyTarget;
  readonly publishDegraded?: boolean;
  readonly ackTargets?: readonly AckTarget[];
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

export type QueueConfig = Pick<Config, "queue" | "concurrency">;

export function prResourceKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

export function installationGroupId(installationId: number): string {
  return String(installationId);
}
