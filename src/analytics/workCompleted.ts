import { posthogSafePhase, type ClassifiedFailure } from "../errors/classifiedFailure.js";
import type { ReviewRunMetricsSnapshot } from "../review/run/reviewRunMetrics.js";
import { MAX_LOG_MESSAGE_LEN } from "../settings/index.js";
import { captureEvent } from "./index.js";

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
  | "durable_degradation"
  | "ci_unavailable";

export type CiWorkTelemetry = {
  readonly rollup: string;
  readonly failingCount: number;
  readonly authored: boolean;
  readonly unavailableReason?: string;
};

export type WorkFailureReason = {
  readonly failureDomain: string;
  readonly errorKind: string;
  readonly providerErrorKind?: string;
  readonly phase?: string;
  readonly errorMessage?: string;
  readonly httpStatus?: number;
  readonly requestPath?: string;
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
  /** Recovery-only. Starts at 0. Increments only on real publish throw/failure, not successful deterministic salvage. */
  readonly publishAttempts: number;
  /** Healthy step shape: specialist reports plus synthesis, plus salvage extras. */
  readonly publishStepCount: number;
};

type PublishedCompletion = { readonly outcome: "published" };
type DurableDegradedCompletion = {
  readonly outcome: "degraded";
  readonly durableDegradation: string;
};

type ReviewCompletionOutcome =
  | PublishedCompletion
  | { readonly outcome: "degraded"; readonly degradedReason: DegradedReason }
  | { readonly outcome: "superseded" }
  | { readonly outcome: "lightweight" }
  | { readonly outcome: "failed"; readonly failure: WorkFailureReason };

export type ReviewProfileFields = {
  readonly reviewLens: string;
  readonly source: "auto" | "slash";
  readonly model?: string;
  readonly provider?: string;
  readonly findingsCount?: number;
  readonly specialistReport?: number;
  readonly specialistEmpty?: number;
  readonly specialistError?: number;
};

/** Closed feature results, not a bag of optional fields shared by unrelated features. */
export type WorkCompletion =
  | ({ readonly kind: "ask"; readonly replyTargetKind: string } & (
      | PublishedCompletion
      | DurableDegradedCompletion
    ))
  | ({ readonly kind: "description"; readonly source: "auto" | "slash" } & (
      | PublishedCompletion
      | DurableDegradedCompletion
      | { readonly outcome: "superseded" }
    ))
  | ({ readonly kind: "triage"; readonly scope: "all" | "thread" } & (
      | PublishedCompletion
      | DurableDegradedCompletion
    ))
  | ({ readonly kind: "verification"; readonly inventoryNarrowed: boolean } & (
      | PublishedCompletion
      | DurableDegradedCompletion
    ))
  | ({
      readonly kind: "review-profile";
      /** Captured at the original executor boundary, before verdict cleanup or runner IO. */
      readonly durationMs: number;
      readonly attemptCount: number;
      readonly publish: PublishTelemetry;
    } & ReviewProfileFields &
      ReviewCompletionOutcome)
  | { readonly kind: "failure"; readonly failure: WorkFailureReason };

export type RecordWorkCompletedInput = {
  readonly item: {
    readonly id: string;
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly headSha: string;
  };
  readonly workType: TelemetryWorkType;
  readonly completion: WorkCompletion;
  readonly durationMs: number;
  readonly attemptCount: number;
  readonly ci?: CiWorkTelemetry;
};

export function workFailureReasonFromClassified(failure: ClassifiedFailure): WorkFailureReason {
  const phase = posthogSafePhase(failure.phase);
  const errorMessage = posthogErrorMessage(failure.errorMessage);
  return {
    failureDomain: failure.failureDomain,
    errorKind: failure.errorKind,
    ...(failure.failureDomain === "provider" ? { providerErrorKind: failure.errorKind } : {}),
    ...(phase != null ? { phase } : {}),
    ...(errorMessage != null ? { errorMessage } : {}),
    ...(failure.httpStatus != null ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.requestPath != null ? { requestPath: failure.requestPath } : {}),
  };
}

function posthogErrorMessage(message: string | undefined): string | undefined {
  if (message == null || message.length === 0) return undefined;
  return message.slice(0, MAX_LOG_MESSAGE_LEN);
}

function failureEnvelopeProperties(
  failure: WorkFailureReason,
): Record<string, string | number | boolean> {
  const errorMessage = posthogErrorMessage(failure.errorMessage);
  const properties: Record<string, string | number | boolean> = {
    failure_domain: failure.failureDomain,
    error_kind: failure.errorKind,
  };
  if (failure.providerErrorKind != null) {
    properties.provider_error_kind = failure.providerErrorKind;
  }
  if (failure.phase != null) properties.phase = failure.phase;
  if (errorMessage != null) properties.error_message = errorMessage;
  if (failure.httpStatus != null) properties.http_status = failure.httpStatus;
  if (failure.requestPath != null) properties.request_path = failure.requestPath;
  return properties;
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

function completionProperties(
  completion: WorkCompletion,
): Record<string, string | number | boolean> {
  switch (completion.kind) {
    case "ask":
      return { reply_target_kind: completion.replyTargetKind };
    case "description":
      return { source: completion.source };
    case "triage":
      return { scope: completion.scope };
    case "verification":
      return { inventory_narrowed: completion.inventoryNarrowed };
    case "failure":
      return {};
    case "review-profile":
      return {
        review_lens: completion.reviewLens,
        source: completion.source,
        ...(completion.model != null ? { model: completion.model } : {}),
        ...(completion.provider != null ? { provider: completion.provider } : {}),
        ...(completion.findingsCount != null ? { findings_count: completion.findingsCount } : {}),
        ...(completion.specialistReport != null
          ? { specialist_report: completion.specialistReport }
          : {}),
        ...(completion.specialistEmpty != null
          ? { specialist_empty: completion.specialistEmpty }
          : {}),
        ...(completion.specialistError != null
          ? { specialist_error: completion.specialistError }
          : {}),
      };
    default: {
      const exhaustive: never = completion;
      return exhaustive;
    }
  }
}

function ciProperties(ci: CiWorkTelemetry | undefined): Record<string, string | number | boolean> {
  if (ci == null) return {};
  return {
    ci_rollup: ci.rollup,
    ci_failing_count: ci.failingCount,
    ci_authored: ci.authored,
    ...(ci.unavailableReason != null ? { ci_unavailable_reason: ci.unavailableReason } : {}),
  };
}

/** Called by the durable runner only after its terminal state write wins. */
export function recordWorkCompleted(input: RecordWorkCompletedInput): void {
  const { item, completion, ci } = input;
  const profile = completion.kind === "review-profile" ? completion : undefined;
  const outcome = completion.kind === "failure" ? "failed" : completion.outcome;
  const degradedReason =
    outcome === "degraded"
      ? completion.kind === "review-profile" && completion.outcome === "degraded"
        ? completion.degradedReason
        : "durable_degradation"
      : undefined;
  const ciUnavailable = profile?.outcome === "published" && ci?.unavailableReason != null;
  const effectiveDegradedReason = ciUnavailable ? "ci_unavailable" : degradedReason;
  const failure =
    completion.kind === "failure" ||
    (completion.kind === "review-profile" && completion.outcome === "failed")
      ? completion.failure
      : undefined;
  captureEvent({
    distinctId: installationDistinctId(item.installationId),
    event: "work completed",
    properties: {
      work_item_id: item.id,
      work_type: input.workType,
      outcome: ciUnavailable ? "degraded" : outcome,
      reason: effectiveDegradedReason ?? failure?.errorKind ?? outcome,
      duration_ms: profile?.durationMs ?? input.durationMs,
      attempt_count: profile?.attemptCount ?? input.attemptCount,
      owner: item.owner,
      repo: item.repo,
      pr_number: item.prNumber,
      head_sha: item.headSha,
      publish_attempts: profile?.publish.publishAttempts ?? 0,
      publish_step_count: profile?.publish.publishStepCount ?? 0,
      ...completionProperties(completion),
      ...ciProperties(ci),
      ...(effectiveDegradedReason != null ? { degraded_reason: effectiveDegradedReason } : {}),
      ...("durableDegradation" in completion
        ? { durable_degradation: completion.durableDegradation }
        : {}),
      ...(failure != null ? failureEnvelopeProperties(failure) : {}),
    },
  });
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
  try {
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
        ...failureEnvelopeProperties(input.failure),
      },
    });
  } catch {
    // Telemetry must not replace the error that the durable queue will retry.
  }
}

export type WorkExecutionStopReason =
  | "lease_lost"
  | "cancellation_observed"
  | "job_aborted"
  | "execution_aborted";

/** An execution stopped. This says nothing about the item's durable terminal state. */
export function captureWorkExecutionStopped(
  input: WorkIdentity & {
    readonly executionId: string;
    readonly reason: WorkExecutionStopReason;
    readonly attemptCount: number;
    readonly leaseEpoch: number | null;
  },
): void {
  try {
    captureEvent({
      distinctId: installationDistinctId(input.installationId),
      event: "work execution stopped",
      properties: {
        work_item_id: input.workItemId,
        work_type: input.workType,
        execution_id: input.executionId,
        reason: input.reason,
        attempt_count: input.attemptCount,
        ...(input.leaseEpoch != null ? { lease_epoch: input.leaseEpoch } : {}),
        owner: input.owner,
        repo: input.repo,
        pr_number: input.prNumber,
        head_sha: input.headSha,
      },
    });
  } catch {
    // Stopping work never depends on analytics availability.
  }
}

/** Caller must have acknowledged a winning terminal write and its transaction commit. */
export function captureWorkTerminal(
  input: WorkIdentity & {
    readonly outcome: "cancelled" | "superseded";
    readonly reason: string;
    readonly source: "worker" | "intake";
    readonly executionId?: string;
    readonly attemptCount?: number;
  },
): void {
  try {
    captureEvent({
      distinctId: installationDistinctId(input.installationId),
      event: input.outcome === "cancelled" ? "work item cancelled" : "work item superseded",
      properties: {
        work_item_id: input.workItemId,
        work_type: input.workType,
        outcome: input.outcome,
        reason: input.reason,
        source: input.source,
        ...(input.executionId != null ? { execution_id: input.executionId } : {}),
        ...(input.attemptCount != null ? { attempt_count: input.attemptCount } : {}),
        owner: input.owner,
        repo: input.repo,
        pr_number: input.prNumber,
        head_sha: input.headSha,
      },
    });
  } catch {
    // A committed lifecycle transition must not become another queue attempt.
  }
}

export type CiStateChanged = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly fromRollup: string;
  readonly toRollup: string;
  readonly version: number;
};

export function captureCiStateChanged(input: CiStateChanged): void {
  if (input.fromRollup === input.toRollup) return;
  captureEvent({
    distinctId: installationDistinctId(input.installationId),
    event: "ci state changed",
    properties: {
      owner: input.owner,
      repo: input.repo,
      head_sha: input.headSha,
      from_rollup: input.fromRollup,
      to_rollup: input.toRollup,
      version: input.version,
    },
  });
}
