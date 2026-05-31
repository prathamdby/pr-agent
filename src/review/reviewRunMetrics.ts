import { logInfo, tryUseLogger } from "../evlog.js";
import type { ReviewPhase, ReviewValidationFailureKind } from "../settings/index.js";

export type ReviewMetricEvent =
  | { readonly kind: "phase_enter"; readonly phase: ReviewPhase }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly ok: boolean;
      readonly durationMs?: number;
    }
  | { readonly kind: "submit_validated"; readonly coercions: readonly string[] }
  | {
      readonly kind: "validation_failed";
      readonly failureKind: ReviewValidationFailureKind;
      readonly paths: readonly string[];
    }
  | { readonly kind: "anchor_failure"; readonly count: number; readonly files: readonly string[] }
  | { readonly kind: "prose_only"; readonly phase: ReviewPhase }
  | { readonly kind: "rate_limit_circuit_opened" }
  | { readonly kind: "token_near_expiry_guard" }
  | { readonly kind: "diff_cache_empty_at_submit" }
  | { readonly kind: "publish_attempted" }
  | {
      readonly kind: "published";
      readonly findingsCount: number;
      readonly severities: readonly string[];
    };

export type ReviewRunMetricsSnapshot = {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly startedAtMs: number;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly submitCallCount: number;
  readonly validationFailureCount: number;
  readonly validationFailureKinds: Record<string, number>;
  readonly coercionsApplied: Record<string, number>;
  readonly anchorFailureCount: number;
  readonly anchorFailureFiles: readonly string[];
  readonly proseOnlyCollapsesByPhase: Record<string, number>;
  readonly phaseRoundCounts: Record<string, number>;
  readonly rateLimitCircuitOpened: boolean;
  readonly tokenNearExpiryGuardHits: number;
  readonly diffCacheEmptyAtFirstSubmit: boolean;
  readonly toolCallCount: number;
  readonly toolCallErrors: number;
  readonly findingsCount: number;
  readonly severities: readonly string[];
  readonly wallClockMs: number;
  readonly lightweight?: boolean;
};

type MutableReviewRunMetrics = {
  provider: string;
  model: string;
  mode: string;
  startedAtMs: number;
  published: boolean;
  publishAttempts: number;
  submitCallCount: number;
  validationFailureCount: number;
  validationFailureKinds: Record<string, number>;
  coercionsApplied: Record<string, number>;
  anchorFailureCount: number;
  anchorFailureFiles: string[];
  proseOnlyCollapsesByPhase: Record<string, number>;
  phaseRoundCounts: Record<string, number>;
  rateLimitCircuitOpened: boolean;
  tokenNearExpiryGuardHits: number;
  diffCacheEmptyAtFirstSubmit: boolean;
  toolCallCount: number;
  toolCallErrors: number;
  findingsCount: number;
  severities: string[];
  lightweight?: boolean;
};

function createEmptyMetrics(meta: {
  provider: string;
  model: string;
  mode: string;
}): MutableReviewRunMetrics {
  return {
    provider: meta.provider,
    model: meta.model,
    mode: meta.mode,
    startedAtMs: Date.now(),
    published: false,
    publishAttempts: 0,
    submitCallCount: 0,
    validationFailureCount: 0,
    validationFailureKinds: {},
    coercionsApplied: {},
    anchorFailureCount: 0,
    anchorFailureFiles: [],
    proseOnlyCollapsesByPhase: {},
    phaseRoundCounts: {},
    rateLimitCircuitOpened: false,
    tokenNearExpiryGuardHits: 0,
    diffCacheEmptyAtFirstSubmit: false,
    toolCallCount: 0,
    toolCallErrors: 0,
    findingsCount: 0,
    severities: [],
  };
}

function getOrInitMetrics(meta?: {
  provider: string;
  model: string;
  mode: string;
}): MutableReviewRunMetrics | null {
  const logger = tryUseLogger();
  if (!logger) return null;
  const ctx = logger.getContext();
  const existing = ctx.reviewRunMetrics as MutableReviewRunMetrics | undefined;
  if (existing) return existing;
  if (!meta) return null;
  const created = createEmptyMetrics(meta);
  logger.set({ reviewRunMetrics: created });
  return created;
}

function bumpRecord(map: Record<string, number>, key: string, delta = 1): void {
  map[key] = (map[key] ?? 0) + delta;
}

export function recordReviewMetric(event: ReviewMetricEvent): void {
  const metrics = getOrInitMetrics();
  if (!metrics) return;

  switch (event.kind) {
    case "phase_enter":
      bumpRecord(metrics.phaseRoundCounts, event.phase);
      break;
    case "tool_call":
      metrics.toolCallCount += 1;
      if (!event.ok) metrics.toolCallErrors += 1;
      break;
    case "submit_validated":
      for (const rule of event.coercions) {
        bumpRecord(metrics.coercionsApplied, rule);
      }
      break;
    case "validation_failed":
      metrics.validationFailureCount += 1;
      bumpRecord(metrics.validationFailureKinds, event.failureKind);
      break;
    case "anchor_failure":
      metrics.anchorFailureCount += event.count;
      for (const file of event.files) {
        if (!metrics.anchorFailureFiles.includes(file)) {
          metrics.anchorFailureFiles.push(file);
        }
      }
      break;
    case "prose_only":
      bumpRecord(metrics.proseOnlyCollapsesByPhase, event.phase);
      break;
    case "rate_limit_circuit_opened":
      metrics.rateLimitCircuitOpened = true;
      break;
    case "token_near_expiry_guard":
      metrics.tokenNearExpiryGuardHits += 1;
      break;
    case "diff_cache_empty_at_submit":
      if (!metrics.diffCacheEmptyAtFirstSubmit) {
        metrics.diffCacheEmptyAtFirstSubmit = true;
      }
      break;
    case "publish_attempted":
      metrics.submitCallCount += 1;
      break;
    case "published":
      metrics.published = true;
      metrics.findingsCount = event.findingsCount;
      metrics.severities = [...event.severities];
      break;
    default: {
      const exhaustive: never = event;
      void exhaustive;
    }
  }
}

export function initReviewRunMetrics(meta: {
  provider: string;
  model: string;
  mode: string;
}): void {
  const logger = tryUseLogger();
  if (!logger) return;
  const existing = logger.getContext().reviewRunMetrics as MutableReviewRunMetrics | undefined;
  if (existing) return;
  logger.set({ reviewRunMetrics: createEmptyMetrics(meta) });
}

export function setReviewRunMetricFields(
  fields: Partial<Pick<MutableReviewRunMetrics, "published" | "publishAttempts" | "lightweight">>,
): void {
  const metrics = getOrInitMetrics();
  if (!metrics) return;
  if (fields.published !== undefined) metrics.published = fields.published;
  if (fields.publishAttempts !== undefined) metrics.publishAttempts = fields.publishAttempts;
  if (fields.lightweight !== undefined) metrics.lightweight = fields.lightweight;
}

export function snapshotReviewRunMetrics(): ReviewRunMetricsSnapshot | null {
  const metrics = getOrInitMetrics();
  if (!metrics) return null;
  const wallClockMs = Date.now() - metrics.startedAtMs;
  return {
    provider: metrics.provider,
    model: metrics.model,
    mode: metrics.mode,
    startedAtMs: metrics.startedAtMs,
    published: metrics.published,
    publishAttempts: metrics.publishAttempts,
    submitCallCount: metrics.submitCallCount,
    validationFailureCount: metrics.validationFailureCount,
    validationFailureKinds: { ...metrics.validationFailureKinds },
    coercionsApplied: { ...metrics.coercionsApplied },
    anchorFailureCount: metrics.anchorFailureCount,
    anchorFailureFiles: [...metrics.anchorFailureFiles],
    proseOnlyCollapsesByPhase: { ...metrics.proseOnlyCollapsesByPhase },
    phaseRoundCounts: { ...metrics.phaseRoundCounts },
    rateLimitCircuitOpened: metrics.rateLimitCircuitOpened,
    tokenNearExpiryGuardHits: metrics.tokenNearExpiryGuardHits,
    diffCacheEmptyAtFirstSubmit: metrics.diffCacheEmptyAtFirstSubmit,
    toolCallCount: metrics.toolCallCount,
    toolCallErrors: metrics.toolCallErrors,
    findingsCount: metrics.findingsCount,
    severities: [...metrics.severities],
    wallClockMs,
    ...(metrics.lightweight !== undefined ? { lightweight: metrics.lightweight } : {}),
  };
}

export function logReviewRunCompleted(extra?: Record<string, unknown>): void {
  const snapshot = snapshotReviewRunMetrics();
  if (!snapshot) return;
  logInfo("review_run_completed", { ...snapshot, ...extra });
}
