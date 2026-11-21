import {
  DEFAULT_ACK_CONCURRENCY,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_RETENTION_ENABLED,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_TRIAGE_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
} from "../defaults.ts";
import { ENV } from "../envKeys.ts";
import { readNonNegativeNumber, readPositiveNumber, readStrictBoolean } from "../envReaders.ts";

export type QueueSlice = {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryDelayMaxSeconds: number;
};

export type ConcurrencySlice = {
  readonly review: number;
  readonly ask: number;
  readonly ack: number;
  readonly description: number;
  readonly triage: number;
  readonly verification: number;
};

export type RetentionSlice = {
  readonly webhookEventsSeconds: number;
  readonly agentWorkSeconds: number;
  readonly enabled: boolean;
};

export function readQueueSlice() {
  return ((pinnedReturn: QueueSlice) => pinnedReturn)({
    retryLimit: readNonNegativeNumber(ENV.QUEUE_RETRY_LIMIT, DEFAULT_QUEUE_RETRY_LIMIT),
    retryDelaySeconds: readNonNegativeNumber(
      ENV.QUEUE_RETRY_DELAY_SECONDS,
      DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
    ),
    retryDelayMaxSeconds: readPositiveNumber(
      ENV.QUEUE_RETRY_DELAY_MAX_SECONDS,
      DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
    ),
  });
}

export function readConcurrencySlice() {
  return ((pinnedReturn: ConcurrencySlice) => pinnedReturn)({
    review: readPositiveNumber(ENV.REVIEW_CONCURRENCY, DEFAULT_REVIEW_CONCURRENCY),
    ask: readPositiveNumber(ENV.ASK_CONCURRENCY, DEFAULT_ASK_CONCURRENCY),
    ack: readPositiveNumber(ENV.ACK_CONCURRENCY, DEFAULT_ACK_CONCURRENCY),
    description: readPositiveNumber(ENV.DESCRIPTION_CONCURRENCY, DEFAULT_DESCRIPTION_CONCURRENCY),
    triage: readPositiveNumber(ENV.TRIAGE_CONCURRENCY, DEFAULT_TRIAGE_CONCURRENCY),
    verification: readPositiveNumber(
      ENV.VERIFICATION_CONCURRENCY,
      DEFAULT_VERIFICATION_CONCURRENCY,
    ),
  });
}

export function readRetentionSlice() {
  return ((pinnedReturn: RetentionSlice) => pinnedReturn)({
    webhookEventsSeconds: readPositiveNumber(
      ENV.WEBHOOK_EVENTS_RETENTION_SECONDS,
      DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
    ),
    agentWorkSeconds: readPositiveNumber(
      ENV.AGENT_WORK_RETENTION_SECONDS,
      DEFAULT_AGENT_WORK_RETENTION_SECONDS,
    ),
    enabled: readStrictBoolean(ENV.RETENTION_ENABLED, DEFAULT_RETENTION_ENABLED),
  });
}
