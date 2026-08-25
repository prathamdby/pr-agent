import type { Config } from "../../config.js";
import type { ProviderErrorKind } from "../../agent/providers/providerErrors.js";
import type { ClassifiedFailure } from "../../errors/classifiedFailure.js";
import type { ReviewPhase, ReviewValidationFailureKind } from "../../settings/index.js";
import type { ReviewRunMetricsSnapshot } from "./reviewRunMetrics.js";

export type ReviewProfilerOutcome =
  | "published"
  | "failed"
  | "degraded"
  | "superseded"
  | "lightweight";

export type ReviewWorkClaim = {
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly attemptCount: number;
};

const KNOWN_PHASES = [
  "preflight",
  "db-read",
  "investigation",
  "pre_submit",
  "validation_repair",
  "publish_recovery",
  "plaintext_fallback",
] as const satisfies readonly (ReviewPhase | "preflight" | "db-read")[];

const KNOWN_SPECIALIST_OUTCOMES = ["report", "empty", "error"] as const;

const KNOWN_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

const KNOWN_VALIDATION_KINDS = [
  "missing_field",
  "wrong_type",
  "enum_mismatch",
  "string_too_short",
  "array_too_long",
  "out_of_range",
  "custom_predicate",
  "other",
] as const satisfies readonly ReviewValidationFailureKind[];

export function reviewProfilerOutcome(input: {
  readonly published: boolean;
  readonly publishSuperseded?: boolean;
  readonly publishAttempts?: number;
  readonly snapshot?: ReviewRunMetricsSnapshot | null;
}): ReviewProfilerOutcome {
  if (input.publishSuperseded) return "superseded";
  if (!input.published) return "failed";
  if (isDegradedPublish(input.snapshot, input.publishAttempts ?? 0)) return "degraded";
  return "published";
}

const SAFE_FAILURE_PHASES = new Set([
  "preflight",
  "db-read",
  "investigation",
  "pre_submit",
  "validation_repair",
  "publish_recovery",
  "plaintext_fallback",
  "recon",
  "specialist",
  "judgment",
  "synthesis",
  "publish",
  "ci_summary",
]);

const PROVIDER_ERROR_KINDS = new Set<ProviderErrorKind>([
  "auth",
  "quota",
  "billing",
  "rate_limit",
  "timeout",
  "unknown",
]);

export function reviewProfilerFailureProperties(
  failure: ClassifiedFailure,
): Record<string, string> {
  const properties: Record<string, string> = {
    failure_domain: failure.failureDomain,
    error_kind: failure.errorKind,
  };
  if (
    failure.failureDomain === "provider" &&
    PROVIDER_ERROR_KINDS.has(failure.errorKind as ProviderErrorKind)
  ) {
    properties.provider_error_kind = failure.errorKind;
  }
  if (failure.phase != null && SAFE_FAILURE_PHASES.has(failure.phase)) {
    properties.phase = failure.phase;
  }
  return properties;
}

export function reviewProfilerProperties(input: {
  readonly snapshot: ReviewRunMetricsSnapshot | null;
  readonly cfg: Pick<Config, "piProvider" | "piModel">;
  readonly claim?: ReviewWorkClaim | null;
  readonly nowMs?: number;
  readonly publishAttempts?: number;
}): Record<string, string | number | boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const properties: Record<string, string | number | boolean> = {
    provider: input.cfg.piProvider,
    model: input.cfg.piModel,
  };
  addClaimTiming(properties, input.claim, nowMs);
  if (!input.snapshot) {
    if (input.publishAttempts != null) properties.publish_attempts = input.publishAttempts;
    return properties;
  }
  addSnapshotProperties(properties, input.snapshot);
  if (input.publishAttempts != null) properties.publish_attempts = input.publishAttempts;
  return properties;
}

function isDegradedPublish(
  snapshot: ReviewRunMetricsSnapshot | null | undefined,
  publishAttempts: number,
): boolean {
  if (publishAttempts > 1) return true;
  if (!snapshot) return false;
  return (
    snapshot.briefFallback ||
    snapshot.rateLimitCircuitOpened ||
    snapshot.validationFailureCount > 0 ||
    snapshot.toolCallErrors > 0
  );
}

function addClaimTiming(
  properties: Record<string, string | number | boolean>,
  claim: ReviewWorkClaim | null | undefined,
  nowMs: number,
): void {
  if (!claim) return;
  const createdAtMs = claim.createdAt.getTime();
  const startedAtMs = claim.startedAt.getTime();
  properties.attempt_count = claim.attemptCount;
  properties.queue_ms = Math.max(0, startedAtMs - createdAtMs);
  properties.review_ms = Math.max(0, nowMs - startedAtMs);
  properties.total_ms = Math.max(0, nowMs - createdAtMs);
}

function addSnapshotProperties(
  properties: Record<string, string | number | boolean>,
  snapshot: ReviewRunMetricsSnapshot,
): void {
  addPresent(properties, "wall_clock_ms", snapshot.wallClockMs);
  addPresent(properties, "provider_input_tokens", snapshot.providerInputTokens);
  addPresent(properties, "provider_output_tokens", snapshot.providerOutputTokens);
  addPresent(properties, "estimated_input_tokens", snapshot.estimatedInputTokens);
  addPresent(properties, "estimated_output_tokens", snapshot.estimatedOutputTokens);
  addPresent(properties, "estimated_turn_count", snapshot.estimatedTurnCount);
  addPresent(properties, "model_turn_count", snapshot.modelTurnCount);
  addPresent(properties, "token_coverage", snapshot.tokenCoverage);
  addPresent(properties, "tool_call_count", snapshot.toolCallCount);
  addPresent(properties, "tool_call_errors", snapshot.toolCallErrors);
  addPresent(properties, "tool_ms", snapshot.toolMs);
  addPresent(properties, "provider_send_ms", snapshot.providerSendMs);
  addPresent(properties, "tool_result_bytes", snapshot.toolResultBytes);
  addPresent(properties, "findings_count", snapshot.findingsCount);
  addPresent(properties, "publish_attempts", snapshot.publishAttempts);
  addPresent(properties, "published", snapshot.published);
  addPresent(properties, "thread_batches", snapshot.threadBatches);
  addPresent(properties, "submit_call_count", snapshot.submitCallCount);
  addPresent(properties, "brief_fallback", snapshot.briefFallback);
  addPresent(properties, "rate_limit_circuit_opened", snapshot.rateLimitCircuitOpened);
  addPresent(properties, "validation_failure_count", snapshot.validationFailureCount);
  addPresent(properties, "token_near_expiry_guard_hits", snapshot.tokenNearExpiryGuardHits);
  addPresent(properties, "diff_cache_empty_at_first_submit", snapshot.diffCacheEmptyAtFirstSubmit);
  addPresent(properties, "anchor_failure_count", snapshot.anchorFailureCount);
  if (snapshot.coercionsApplied) properties.coercion_count = sumRecord(snapshot.coercionsApplied);
  if (snapshot.toolInputRepairs) {
    properties.tool_input_repair_count = sumRecord(snapshot.toolInputRepairs);
  }
  if (snapshot.lightweight !== undefined) properties.lightweight = snapshot.lightweight;
  if (snapshot.generationMs != null && snapshot.generationMs > 0) {
    properties.generation_ms = snapshot.generationMs;
    const tps =
      snapshot.providerOutputTps ??
      (snapshot.providerOutputTokens != null
        ? snapshot.providerOutputTokens / (snapshot.generationMs / 1000)
        : undefined);
    if (tps != null) properties.provider_output_tps = Math.round(tps * 100) / 100;
  }
  addPresent(properties, "cache_read_tokens", snapshot.cacheReadTokens);
  addPresent(properties, "cache_write_tokens", snapshot.cacheWriteTokens);
  addPresent(properties, "cache_write_1h_tokens", snapshot.cacheWrite1hTokens);
  addPresent(properties, "cache_hit_rate", snapshot.cacheHitRate);
  addPresent(properties, "cache_write_amplification", snapshot.cacheWriteAmplification);
  flattenKnown(properties, snapshot.phaseSpansMs, KNOWN_PHASES, "phase_", "_ms");
  flattenKnown(properties, snapshot.phaseRoundCounts, KNOWN_PHASES, "phase_", "_rounds");
  flattenKnown(
    properties,
    snapshot.specialistOutcomes,
    KNOWN_SPECIALIST_OUTCOMES,
    "specialist_",
    "",
  );
  flattenKnown(
    properties,
    snapshot.validationFailureKinds,
    KNOWN_VALIDATION_KINDS,
    "validation_",
    "",
  );
  flattenSeverityCounts(properties, snapshot.severities);
}

function flattenKnown(
  properties: Record<string, string | number | boolean>,
  values: Record<string, number> | undefined,
  known: readonly string[],
  prefix: string,
  suffix: string,
): void {
  if (!values) return;
  for (const name of known) {
    const value = values[name];
    if (value == null) continue;
    properties[`${prefix}${name.replaceAll("-", "_")}${suffix}`] = value;
  }
}

function flattenSeverityCounts(
  properties: Record<string, string | number | boolean>,
  severities: readonly string[] | undefined,
): void {
  const counts: Record<(typeof KNOWN_SEVERITIES)[number], number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  if (!severities) return;
  for (const severity of severities) {
    if (severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3") {
      counts[severity] += 1;
    }
  }
  for (const severity of KNOWN_SEVERITIES) {
    if (counts[severity] > 0) properties[`findings_${severity.toLowerCase()}`] = counts[severity];
  }
}

function addPresent(
  properties: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value == null) return;
  properties[key] = value;
}

function sumRecord(values: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(values)) total += value;
  return total;
}
