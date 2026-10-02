import { AppError } from "../../errors/appError.js";
import {
  DEFAULT_ACK_CONCURRENCY,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
  DEFAULT_PR_ACTOR_LEASE_TTL_SECONDS,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DEFAULT_TRIAGE_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
} from "../defaults.js";
import { ENV } from "../envKeys.js";
import {
  optionalEnv,
  readNonNegativeNumber,
  readPositiveNumber,
  readStrictBoolean,
} from "../envReaders.js";

/** pg-boss delivery, retry, expiry, and PR actor lease timing. */
export type QueueSlice = {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryDelayMaxSeconds: number;
  readonly expireInSeconds: number;
  readonly prActorLeaseTtlSeconds: number;
  readonly prActorLeaseRenewalIntervalSeconds: number;
  readonly heartbeatSeconds: number;
  readonly pollingIntervalSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
  readonly shutdownDrainTimeoutSeconds: number;
};

/** Per-lane worker concurrency. */
export type ConcurrencySlice = {
  readonly review: number;
  readonly ask: number;
  readonly ack: number;
  readonly description: number;
  readonly triage: number;
  readonly verification: number;
  readonly installationGroup: number;
};

/** Database retention sweep for webhook events and agent work. */
export type RetentionSlice = {
  readonly webhookEventsSeconds: number;
  readonly agentWorkSeconds: number;
  readonly cron: string;
  readonly enabled: boolean;
};

export function readQueueSlice(): QueueSlice {
  const queueRetryLimit = readNonNegativeNumber(ENV.QUEUE_RETRY_LIMIT, DEFAULT_QUEUE_RETRY_LIMIT);
  const queueRetryDelaySeconds = readNonNegativeNumber(
    ENV.QUEUE_RETRY_DELAY_SECONDS,
    DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  );
  const queueRetryDelayMaxSeconds = readPositiveNumber(
    ENV.QUEUE_RETRY_DELAY_MAX_SECONDS,
    DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  );
  const queueExpireInSeconds = readPositiveNumber(
    ENV.QUEUE_EXPIRE_IN_SECONDS,
    DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  );

  const prActorLeaseTtlSeconds = readPositiveNumber(
    ENV.PR_ACTOR_LEASE_TTL_SECONDS,
    DEFAULT_PR_ACTOR_LEASE_TTL_SECONDS,
  );
  const prActorLeaseRenewalIntervalSeconds = readPositiveNumber(
    ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
    DEFAULT_PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
  );
  if (prActorLeaseRenewalIntervalSeconds >= prActorLeaseTtlSeconds) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: `${ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS} must be less than ${ENV.PR_ACTOR_LEASE_TTL_SECONDS}`,
      context: {
        name: ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
        prActorLeaseTtlSeconds,
        prActorLeaseRenewalIntervalSeconds,
      },
    });
  }

  const queueHeartbeatSeconds = Number(
    optionalEnv(ENV.QUEUE_HEARTBEAT_SECONDS, String(DEFAULT_QUEUE_HEARTBEAT_SECONDS)),
  );
  if (!Number.isFinite(queueHeartbeatSeconds) || queueHeartbeatSeconds < 10) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: "QUEUE_HEARTBEAT_SECONDS must be at least 10",
      context: { name: ENV.QUEUE_HEARTBEAT_SECONDS },
    });
  }

  const queuePollingIntervalSeconds = Number(
    optionalEnv(ENV.QUEUE_POLLING_INTERVAL_SECONDS, String(DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS)),
  );
  if (!Number.isFinite(queuePollingIntervalSeconds) || queuePollingIntervalSeconds < 0.5) {
    throw new AppError({
      domain: "config",
      kind: "invalid_number",
      message: "QUEUE_POLLING_INTERVAL_SECONDS must be at least 0.5",
      context: { name: ENV.QUEUE_POLLING_INTERVAL_SECONDS },
    });
  }

  const queueRetentionSeconds = readPositiveNumber(
    ENV.QUEUE_RETENTION_SECONDS,
    DEFAULT_QUEUE_RETENTION_SECONDS,
  );
  const queueDeleteAfterSeconds = readNonNegativeNumber(
    ENV.QUEUE_DELETE_AFTER_SECONDS,
    DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  );

  const shutdownDrainTimeoutSeconds = readPositiveNumber(
    ENV.SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
    DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  );

  return {
    retryLimit: queueRetryLimit,
    retryDelaySeconds: queueRetryDelaySeconds,
    retryDelayMaxSeconds: queueRetryDelayMaxSeconds,
    expireInSeconds: queueExpireInSeconds,
    prActorLeaseTtlSeconds,
    prActorLeaseRenewalIntervalSeconds,
    heartbeatSeconds: queueHeartbeatSeconds,
    pollingIntervalSeconds: queuePollingIntervalSeconds,
    retentionSeconds: queueRetentionSeconds,
    deleteAfterSeconds: queueDeleteAfterSeconds,
    shutdownDrainTimeoutSeconds,
  };
}

export function readConcurrencySlice(): ConcurrencySlice {
  return {
    review: readPositiveNumber(ENV.REVIEW_CONCURRENCY, DEFAULT_REVIEW_CONCURRENCY),
    ask: readPositiveNumber(ENV.ASK_CONCURRENCY, DEFAULT_ASK_CONCURRENCY),
    ack: readPositiveNumber(ENV.ACK_CONCURRENCY, DEFAULT_ACK_CONCURRENCY),
    description: readPositiveNumber(ENV.DESCRIPTION_CONCURRENCY, DEFAULT_DESCRIPTION_CONCURRENCY),
    triage: readPositiveNumber(ENV.TRIAGE_CONCURRENCY, DEFAULT_TRIAGE_CONCURRENCY),
    verification: readPositiveNumber(
      ENV.VERIFICATION_CONCURRENCY,
      DEFAULT_VERIFICATION_CONCURRENCY,
    ),
    installationGroup: readPositiveNumber(
      ENV.INSTALLATION_GROUP_CONCURRENCY,
      DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
    ),
  };
}

export function readRetentionSlice(): RetentionSlice {
  return {
    webhookEventsSeconds: readPositiveNumber(
      ENV.WEBHOOK_EVENTS_RETENTION_SECONDS,
      DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
    ),
    agentWorkSeconds: readPositiveNumber(
      ENV.AGENT_WORK_RETENTION_SECONDS,
      DEFAULT_AGENT_WORK_RETENTION_SECONDS,
    ),
    cron: optionalEnv(ENV.RETENTION_CRON, DEFAULT_RETENTION_CRON),
    enabled: readStrictBoolean(ENV.RETENTION_ENABLED, DEFAULT_RETENTION_ENABLED),
  };
}
