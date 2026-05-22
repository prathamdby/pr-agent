import type { Config } from "../config.js";
import type { CodeAnchor } from "../agent/askRun.js";
import type { ReviewMode } from "../agent/reviewSchema.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  DEFERRED_HEAD_SHA,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
} from "../settings/index.js";

export {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  DEFERRED_HEAD_SHA,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
} from "../settings/index.js";

export type WorkType = "review" | "ask";
export type WorkSource = "auto" | "slash";
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

export type ReviewWorkPayload = {
  readonly mode: ReviewMode;
  readonly source: WorkSource;
  readonly userSupplement?: string;
  readonly commenterId?: number;
  /** Set when the run finished but structured publish did not succeed */
  readonly publishDegraded?: boolean;
};

export type AskWorkPayload = {
  readonly question: string;
  readonly replyTarget: ReplyTarget;
  readonly codeAnchor?: CodeAnchor;
  readonly commenterId?: number;
  readonly commentId: number;
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
  readonly payload: ReviewWorkPayload | AskWorkPayload;
  readonly cancelRequestedAt: Date | null;
};

export type QueueConfig = Pick<
  Config,
  | "queueRetryLimit"
  | "queueRetryDelaySeconds"
  | "queueRetryDelayMaxSeconds"
  | "queueExpireInSeconds"
  | "queueHeartbeatSeconds"
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

export function installationGroupId(installationId: number): string {
  return String(installationId);
}
