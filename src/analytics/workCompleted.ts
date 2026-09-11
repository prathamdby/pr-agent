import { captureEvent } from "./index.js";
import { posthogSafePhase, type ClassifiedFailure } from "../errors/classifiedFailure.js";
import type { ReviewRunMetricsSnapshot } from "../review/run/reviewRunMetrics.js";

/** Duplicate of agent-work `WorkType`. Analytics must not import that module. */
export type TelemetryWorkType = "review" | "ask" | "description" | "triage" | "verification";

export type WorkCompletedOutcome =
  | "published"
  | "degraded"
  | "failed"
  | "superseded"
  | "lightweight";

export type DegradedReason =
  | "publish_retry"
  | "brief_fallback"
  | "rate_limit_circuit"
  | "validation_failure"
  | "tool_call_error"
  | "durable_degradation";

export type WorkFailureReason = {
  readonly failureDomain: string;
  readonly errorKind: string;
  readonly providerErrorKind?: string;
  readonly phase?: string;
};

export type WorkIdentity = {
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly workType: TelemetryWorkType;
};

export type AnalyticsDistinctId = `installation:${number}` | "server";

export function installationDistinctId(installationId: number): AnalyticsDistinctId {
  return `installation:${installationId}`;
}

export type PublishTelemetry = {
  /** Recovery-only. Starts at 0. Increments on deterministic/salvage publish. */
  readonly publishAttempts: number;
  /** Healthy step shape: specialist reports plus synthesis, plus salvage extras. */
  readonly publishStepCount: number;
};

export type WorkCompletedBase = WorkIdentity & {
  readonly distinctId: AnalyticsDistinctId;
  readonly durationMs: number;
  readonly attemptCount: number;
  readonly publish: PublishTelemetry;
};

export type WorkCompletedPublished = WorkCompletedBase & {
  readonly outcome: "published";
  readonly reason: "published";
};

export type WorkCompletedDegraded = WorkCompletedBase & {
  readonly outcome: "degraded";
  readonly reason: DegradedReason;
  readonly degradedReason: DegradedReason;
};

export type WorkCompletedFailed = WorkCompletedBase & {
  readonly outcome: "failed";
  readonly reason: string;
  readonly failure: WorkFailureReason;
};

export type WorkCompletedSuperseded = WorkCompletedBase & {
  readonly outcome: "superseded";
  readonly reason: "superseded";
};

export type WorkCompletedLightweight = WorkCompletedBase & {
  readonly outcome: "lightweight";
  readonly reason: "lightweight";
};

export type WorkCompleted =
  | WorkCompletedPublished
  | WorkCompletedDegraded
  | WorkCompletedFailed
  | WorkCompletedSuperseded
  | WorkCompletedLightweight;

export type ReviewWorkExtras = {
  readonly reviewLens?: string;
  readonly source?: "auto" | "slash";
  readonly findingsCount?: number;
  readonly specialistReport?: number;
  readonly specialistEmpty?: number;
  readonly specialistError?: number;
  readonly model?: string;
  readonly provider?: string;
};

export type AskWorkExtras = {
  readonly replyTargetKind?: string;
  readonly durableDegradation?: string;
};

export type DescriptionWorkExtras = {
  readonly source?: string;
  readonly durableDegradation?: string;
};

export type TriageWorkExtras = {
  readonly scope?: string;
  readonly durableDegradation?: string;
};

export type VerificationWorkExtras = {
  readonly inventoryNarrowed?: boolean;
  readonly durableDegradation?: string;
};

export type WorkCompletedExtras =
  | ReviewWorkExtras
  | AskWorkExtras
  | DescriptionWorkExtras
  | TriageWorkExtras
  | VerificationWorkExtras;

export type CaptureWorkCompletedInput = WorkCompleted & {
  readonly extras?: WorkCompletedExtras;
};

const EMPTY_PUBLISH: PublishTelemetry = { publishAttempts: 0, publishStepCount: 0 };

export function workFailureReasonFromClassified(failure: ClassifiedFailure): WorkFailureReason {
  const phase = posthogSafePhase(failure.phase);
  return {
    failureDomain: failure.failureDomain,
    errorKind: failure.errorKind,
    ...(failure.failureDomain === "provider" ? { providerErrorKind: failure.errorKind } : {}),
    ...(phase != null ? { phase } : {}),
  };
}

export function degradedReasonFromReviewFlags(input: {
  readonly publishAttempts: number;
  readonly snapshot?: ReviewRunMetricsSnapshot | null;
}): DegradedReason | null {
  if (input.publishAttempts > 0) return "publish_retry";
  const snapshot = input.snapshot;
  if (!snapshot) return null;
  if (snapshot.briefFallback) return "brief_fallback";
  if (snapshot.rateLimitCircuitOpened) return "rate_limit_circuit";
  if (snapshot.validationFailureCount > 0) return "validation_failure";
  if (snapshot.toolCallErrors > 0) return "tool_call_error";
  return null;
}

export function reviewWorkOutcome(input: {
  readonly published: boolean;
  readonly publishSuperseded?: boolean;
  readonly lightweight?: boolean;
  readonly publishAttempts?: number;
  readonly snapshot?: ReviewRunMetricsSnapshot | null;
}): WorkCompletedOutcome {
  if (input.publishSuperseded) return "superseded";
  if (input.lightweight) return "lightweight";
  if (!input.published) return "failed";
  if (
    degradedReasonFromReviewFlags({
      publishAttempts: input.publishAttempts ?? 0,
      snapshot: input.snapshot,
    }) != null
  ) {
    return "degraded";
  }
  return "published";
}

export function durationMsFromClaim(
  claim: { readonly startedAt: Date } | null | undefined,
  nowMs = Date.now(),
): number {
  if (!claim) return 0;
  return Math.max(0, nowMs - claim.startedAt.getTime());
}

function scalarProperties(
  extras: WorkCompletedExtras | undefined,
): Record<string, string | number | boolean> {
  if (!extras) return {};
  const properties: Record<string, string | number | boolean> = {};
  if ("reviewLens" in extras && extras.reviewLens != null)
    properties.review_lens = extras.reviewLens;
  if ("source" in extras && extras.source != null) properties.source = extras.source;
  if ("findingsCount" in extras && extras.findingsCount != null) {
    properties.findings_count = extras.findingsCount;
  }
  if ("specialistReport" in extras && extras.specialistReport != null) {
    properties.specialist_report = extras.specialistReport;
  }
  if ("specialistEmpty" in extras && extras.specialistEmpty != null) {
    properties.specialist_empty = extras.specialistEmpty;
  }
  if ("specialistError" in extras && extras.specialistError != null) {
    properties.specialist_error = extras.specialistError;
  }
  if ("model" in extras && extras.model != null) properties.model = extras.model;
  if ("provider" in extras && extras.provider != null) properties.provider = extras.provider;
  if ("replyTargetKind" in extras && extras.replyTargetKind != null) {
    properties.reply_target_kind = extras.replyTargetKind;
  }
  if ("scope" in extras && extras.scope != null) properties.scope = extras.scope;
  if ("inventoryNarrowed" in extras && extras.inventoryNarrowed != null) {
    properties.inventory_narrowed = extras.inventoryNarrowed;
  }
  if ("durableDegradation" in extras && extras.durableDegradation != null) {
    properties.durable_degradation = extras.durableDegradation;
  }
  return properties;
}

function envelopeProperties(
  input: CaptureWorkCompletedInput,
): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {
    work_item_id: input.workItemId,
    work_type: input.workType,
    outcome: input.outcome,
    reason: input.reason,
    duration_ms: input.durationMs,
    attempt_count: input.attemptCount,
    owner: input.owner,
    repo: input.repo,
    pr_number: input.prNumber,
    head_sha: input.headSha,
    publish_attempts: input.publish.publishAttempts,
    publish_step_count: input.publish.publishStepCount,
    ...scalarProperties(input.extras),
  };
  switch (input.outcome) {
    case "published":
    case "superseded":
    case "lightweight":
      return properties;
    case "degraded":
      properties.degraded_reason = input.degradedReason;
      return properties;
    case "failed":
      properties.failure_domain = input.failure.failureDomain;
      properties.error_kind = input.failure.errorKind;
      if (input.failure.providerErrorKind != null) {
        properties.provider_error_kind = input.failure.providerErrorKind;
      }
      if (input.failure.phase != null) properties.phase = input.failure.phase;
      return properties;
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

export function captureWorkCompleted(input: CaptureWorkCompletedInput): void {
  captureEvent({
    distinctId: input.distinctId,
    event: "work completed",
    properties: envelopeProperties(input),
  });
}

export function identityFromWorkItem(
  item: {
    readonly id: string;
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly headSha: string;
  },
  workType: TelemetryWorkType,
): WorkIdentity {
  return {
    workItemId: item.id,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha: item.headSha,
    workType,
  };
}

export function captureDurableWorkCompleted(input: {
  readonly item: {
    readonly id: string;
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly headSha: string;
  };
  readonly workType: TelemetryWorkType;
  readonly outcome: WorkCompletedOutcome;
  readonly durationMs: number;
  readonly attemptCount: number;
  readonly publish?: PublishTelemetry;
  readonly degradedReason?: DegradedReason;
  readonly failure?: WorkFailureReason;
  readonly extras?: WorkCompletedExtras;
}): void {
  const identity = identityFromWorkItem(input.item, input.workType);
  const distinctId = installationDistinctId(input.item.installationId);
  const publish = input.publish ?? EMPTY_PUBLISH;
  const base = {
    ...identity,
    distinctId,
    durationMs: input.durationMs,
    attemptCount: input.attemptCount,
    publish,
  };
  switch (input.outcome) {
    case "published":
      captureWorkCompleted({
        ...base,
        outcome: "published",
        reason: "published",
        extras: input.extras,
      });
      return;
    case "superseded":
      captureWorkCompleted({
        ...base,
        outcome: "superseded",
        reason: "superseded",
        extras: input.extras,
      });
      return;
    case "lightweight":
      captureWorkCompleted({
        ...base,
        outcome: "lightweight",
        reason: "lightweight",
        extras: input.extras,
      });
      return;
    case "degraded": {
      const degradedReason = input.degradedReason ?? "durable_degradation";
      captureWorkCompleted({
        ...base,
        outcome: "degraded",
        reason: degradedReason,
        degradedReason,
        extras: input.extras,
      });
      return;
    }
    case "failed": {
      const failure = input.failure ?? {
        failureDomain: "unknown",
        errorKind: "unknown",
      };
      captureWorkCompleted({
        ...base,
        outcome: "failed",
        reason: failure.errorKind,
        failure,
        extras: input.extras,
      });
      return;
    }
    default: {
      const exhaustive: never = input.outcome;
      return exhaustive;
    }
  }
}

export type WebhookOutcome = "accepted" | "duplicate" | "rejected";

export type WebhookReceived = {
  readonly githubEvent: string;
  readonly delivery: string;
  readonly elapsedMs: number;
  readonly outcome: WebhookOutcome;
  readonly reason?: string;
};

export function captureWebhookReceived(input: WebhookReceived): void {
  const properties: Record<string, string | number> = {
    github_event: input.githubEvent,
    delivery: input.delivery,
    elapsed_ms: input.elapsedMs,
    outcome: input.outcome,
  };
  if (input.reason != null) properties.reason = input.reason;
  captureEvent({
    distinctId: "server",
    event: "webhook received",
    properties,
  });
}

export type WorkItemRetried = WorkIdentity & {
  readonly attemptCount: number;
  readonly nextAttempt: number;
  readonly retryDisposition: string;
  readonly escalationKinds: readonly string[];
  readonly failure: WorkFailureReason;
};

export function captureWorkRetried(input: WorkItemRetried): void {
  captureEvent({
    distinctId: installationDistinctId(input.installationId),
    event: "work item retried",
    properties: {
      work_item_id: input.workItemId,
      work_type: input.workType,
      owner: input.owner,
      repo: input.repo,
      pr_number: input.prNumber,
      head_sha: input.headSha,
      attempt_count: input.attemptCount,
      next_attempt: input.nextAttempt,
      retry_disposition: input.retryDisposition,
      escalation_kinds: [...input.escalationKinds],
      failure_domain: input.failure.failureDomain,
      error_kind: input.failure.errorKind,
      ...(input.failure.providerErrorKind != null
        ? { provider_error_kind: input.failure.providerErrorKind }
        : {}),
      ...(input.failure.phase != null ? { phase: input.failure.phase } : {}),
    },
  });
}
