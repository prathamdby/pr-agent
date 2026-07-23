import type { AgentRunnerTurn } from "../../agent/providers/interface.js";
import { classifyFailure, type ClassifiedFailure } from "../../errors/classifiedFailure.js";
import { logInfo, tryUseLogger } from "../../evlog.js";
import type { ReviewPhase, ReviewValidationFailureKind } from "../../settings/index.js";

const MAX_RECENT_TOOL_ERRORS = 3;

export type ReviewMetricEvent =
  | { readonly kind: "phase_enter"; readonly phase: ReviewPhase }
  | {
      readonly kind: "phase_span";
      readonly phase: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly ok: boolean;
      readonly durationMs?: number;
      readonly resultBytes?: number;
      readonly resultCharacters?: number;
      /** Sanitized provider/tool failure text when ok is false. */
      readonly errorMessage?: string;
    }
  | {
      readonly kind: "external_failure";
      readonly failure: ClassifiedFailure;
    }
  | {
      readonly kind: "model_turn";
      readonly usage?: {
        readonly estimated: boolean;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly totalTokens?: number;
      };
      readonly prompt?: {
        readonly inputCharacters: number;
        readonly inputBytes: number;
      };
    }
  | { readonly kind: "submit_validated"; readonly coercions: readonly string[] }
  | {
      readonly kind: "validation_failed";
      readonly failureKind: ReviewValidationFailureKind;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: "anchor_failure";
      readonly count: number;
      readonly files: readonly string[];
    }
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
  readonly phaseSpansMs: Record<string, number>;
  readonly rateLimitCircuitOpened: boolean;
  readonly tokenNearExpiryGuardHits: number;
  readonly diffCacheEmptyAtFirstSubmit: boolean;
  readonly toolCallCount: number;
  readonly toolCallErrors: number;
  readonly lastFailure: ClassifiedFailure | null;
  readonly recentToolErrors: readonly ClassifiedFailure[];
  readonly toolResultBytes: number;
  readonly toolResultCharacters: number;
  readonly modelTurnCount: number;
  readonly promptBytes: number;
  readonly promptCharacters: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly estimatedTurnCount: number;
  readonly findingsCount: number;
  readonly severities: readonly string[];
  readonly wallClockMs: number;
  readonly lightweight?: boolean;
  readonly specialistOutcomes: Record<string, number>;
  readonly threadBatches: number;
  readonly briefFallback: boolean;
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
  phaseSpansMs: Record<string, number>;
  rateLimitCircuitOpened: boolean;
  tokenNearExpiryGuardHits: number;
  diffCacheEmptyAtFirstSubmit: boolean;
  toolCallCount: number;
  toolCallErrors: number;
  lastFailure: ClassifiedFailure | null;
  recentToolErrors: ClassifiedFailure[];
  toolResultBytes: number;
  toolResultCharacters: number;
  modelTurnCount: number;
  promptBytes: number;
  promptCharacters: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedTurnCount: number;
  findingsCount: number;
  severities: string[];
  lightweight?: boolean;
  specialistOutcomes: Record<string, number>;
  threadBatches: number;
  briefFallback: boolean;
};

function createEmptyMetrics(meta: {
  provider: string;
  model: string;
  mode: string;
  startedAtMs?: number;
}): MutableReviewRunMetrics {
  return {
    provider: meta.provider,
    model: meta.model,
    mode: meta.mode,
    startedAtMs:
      typeof meta.startedAtMs === "number" && Number.isFinite(meta.startedAtMs)
        ? meta.startedAtMs
        : Date.now(),
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
    phaseSpansMs: {},
    rateLimitCircuitOpened: false,
    tokenNearExpiryGuardHits: 0,
    diffCacheEmptyAtFirstSubmit: false,
    toolCallCount: 0,
    toolCallErrors: 0,
    lastFailure: null,
    recentToolErrors: [],
    toolResultBytes: 0,
    toolResultCharacters: 0,
    modelTurnCount: 0,
    promptBytes: 0,
    promptCharacters: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedTurnCount: 0,
    findingsCount: 0,
    severities: [],
    specialistOutcomes: {},
    threadBatches: 0,
    briefFallback: false,
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

function addKnownCacheTotal(current: number | null, delta: number | undefined): number | null {
  if (delta === undefined) return current;
  if (current === null) return delta;
  return current + delta;
}

function recordModelTurnUsage(
  metrics: MutableReviewRunMetrics,
  usage: NonNullable<Extract<ReviewMetricEvent, { kind: "model_turn" }>["usage"]>,
): void {
  if (usage.estimated) {
    metrics.estimatedTurnCount += 1;
    metrics.estimatedInputTokens += usage.inputTokens ?? 0;
    metrics.estimatedOutputTokens += usage.outputTokens ?? 0;
  } else {
    metrics.providerInputTokens += usage.inputTokens ?? 0;
    metrics.providerOutputTokens += usage.outputTokens ?? 0;
    metrics.cacheReadTokens = addKnownCacheTotal(metrics.cacheReadTokens, usage.cacheReadTokens);
    metrics.cacheWriteTokens = addKnownCacheTotal(metrics.cacheWriteTokens, usage.cacheWriteTokens);
  }
}

export function recordReviewMetric(event: ReviewMetricEvent): void {
  const metrics = getOrInitMetrics();
  if (!metrics) return;

  switch (event.kind) {
    case "phase_enter":
      bumpRecord(metrics.phaseRoundCounts, event.phase);
      break;
    case "phase_span":
      bumpRecord(metrics.phaseSpansMs, event.phase, event.durationMs);
      break;
    case "tool_call":
      metrics.toolCallCount += 1;
      if (!event.ok) {
        metrics.toolCallErrors += 1;
        if (event.errorMessage != null && event.errorMessage.length > 0) {
          const failure = classifyFailure(new Error(event.errorMessage), {
            toolName: event.name,
            provider: metrics.provider,
            model: metrics.model,
            errorCount: metrics.toolCallErrors,
          });
          metrics.lastFailure = failure;
          metrics.recentToolErrors.push(failure);
          if (metrics.recentToolErrors.length > MAX_RECENT_TOOL_ERRORS) {
            metrics.recentToolErrors.splice(
              0,
              metrics.recentToolErrors.length - MAX_RECENT_TOOL_ERRORS,
            );
          }
        }
      }
      if (event.resultBytes != null) metrics.toolResultBytes += event.resultBytes;
      if (event.resultCharacters != null) {
        metrics.toolResultCharacters += event.resultCharacters;
      }
      break;
    case "external_failure":
      metrics.lastFailure = {
        ...event.failure,
        errorCount: event.failure.errorCount ?? metrics.toolCallErrors,
      };
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
    case "model_turn":
      metrics.modelTurnCount += 1;
      if (event.prompt) {
        metrics.promptBytes += event.prompt.inputBytes;
        metrics.promptCharacters += event.prompt.inputCharacters;
      }
      if (event.usage) recordModelTurnUsage(metrics, event.usage);
      break;
    default: {
      const exhaustive: never = event;
      void exhaustive;
    }
  }
}

export function recordAgentTurnMetrics(turn: AgentRunnerTurn): void {
  recordReviewMetric({
    kind: "model_turn",
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
  });
}

export async function recordReviewPhaseSpan<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    recordReviewMetric({
      kind: "phase_span",
      phase,
      durationMs: Date.now() - startedAt,
    });
  }
}

export function initReviewRunMetrics(meta: {
  provider: string;
  model: string;
  mode: string;
  startedAtMs?: number;
}): void {
  const logger = tryUseLogger();
  if (!logger) return;
  const existing = logger.getContext().reviewRunMetrics as MutableReviewRunMetrics | undefined;
  if (existing) return;
  logger.set({ reviewRunMetrics: createEmptyMetrics(meta) });
}

export function setReviewRunMetricFields(
  fields: Partial<
    Pick<
      MutableReviewRunMetrics,
      | "published"
      | "publishAttempts"
      | "lightweight"
      | "specialistOutcomes"
      | "threadBatches"
      | "briefFallback"
    >
  >,
): void {
  const metrics = getOrInitMetrics();
  if (!metrics) return;
  if (fields.published !== undefined) metrics.published = fields.published;
  if (fields.publishAttempts !== undefined) metrics.publishAttempts = fields.publishAttempts;
  if (fields.lightweight !== undefined) metrics.lightweight = fields.lightweight;
  if (fields.specialistOutcomes !== undefined) {
    metrics.specialistOutcomes = { ...fields.specialistOutcomes };
  }
  if (fields.threadBatches !== undefined) metrics.threadBatches = fields.threadBatches;
  if (fields.briefFallback !== undefined) metrics.briefFallback = fields.briefFallback;
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
    phaseSpansMs: { ...metrics.phaseSpansMs },
    rateLimitCircuitOpened: metrics.rateLimitCircuitOpened,
    tokenNearExpiryGuardHits: metrics.tokenNearExpiryGuardHits,
    diffCacheEmptyAtFirstSubmit: metrics.diffCacheEmptyAtFirstSubmit,
    toolCallCount: metrics.toolCallCount,
    toolCallErrors: metrics.toolCallErrors,
    lastFailure: metrics.lastFailure,
    recentToolErrors: [...metrics.recentToolErrors],
    toolResultBytes: metrics.toolResultBytes,
    toolResultCharacters: metrics.toolResultCharacters,
    modelTurnCount: metrics.modelTurnCount,
    promptBytes: metrics.promptBytes,
    promptCharacters: metrics.promptCharacters,
    estimatedInputTokens: metrics.estimatedInputTokens,
    estimatedOutputTokens: metrics.estimatedOutputTokens,
    providerInputTokens: metrics.providerInputTokens,
    providerOutputTokens: metrics.providerOutputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    estimatedTurnCount: metrics.estimatedTurnCount,
    findingsCount: metrics.findingsCount,
    severities: [...metrics.severities],
    wallClockMs,
    specialistOutcomes: { ...metrics.specialistOutcomes },
    threadBatches: metrics.threadBatches,
    briefFallback: metrics.briefFallback,
    ...(metrics.lightweight !== undefined ? { lightweight: metrics.lightweight } : {}),
  };
}

export function logReviewRunCompleted(extra?: Record<string, unknown>): void {
  const snapshot = snapshotReviewRunMetrics();
  if (!snapshot) return;
  logInfo("review_run_completed", { ...snapshot, ...extra });
}

/** Persist a classified external/provider/GitHub failure for soft-fail terminal handlers. */
export function recordClassifiedFailure(failure: ClassifiedFailure): void {
  recordReviewMetric({ kind: "external_failure", failure });
}
