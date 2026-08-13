import type { AgentRunnerTurn } from "../../agent/providers/interface.js";
import { classifyFailure, type ClassifiedFailure } from "../../errors/classifiedFailure.js";
import { logInfo, tryUseLogger, type RequestLogger } from "../../evlog.js";
import type { ReviewPhase, ReviewValidationFailureKind } from "../../settings/index.js";
import type { JsonObject } from "../../util/jsonValue.js";

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
      readonly errorMessage?: string;
    }
  | {
      readonly kind: "session_send_span";
      readonly sendMs: number;
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
        readonly cacheWrite1hTokens?: number;
        readonly totalTokens?: number;
      };
      readonly prompt?: {
        readonly inputCharacters: number;
        readonly inputBytes: number;
      };
    }
  | { readonly kind: "submit_validated"; readonly coercions: readonly string[] }
  | {
      readonly kind: "tool_input_repaired";
      readonly tool: string;
      readonly repairs: readonly string[];
    }
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
  readonly toolInputRepairs: Record<string, number>;
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
  readonly cacheWrite1hTokens: number | null;
  /** cacheRead / (input + cacheRead + cacheWrite); null when usage unknown. */
  readonly cacheHitRate: number | null;
  /** cacheWrite / max(cacheRead, 1); null when usage unknown. */
  readonly cacheWriteAmplification: number | null;
  readonly estimatedTurnCount: number;
  readonly findingsCount: number;
  readonly severities: readonly string[];
  readonly wallClockMs: number;
  readonly lightweight?: boolean;
  readonly specialistOutcomes: Record<string, number>;
  readonly threadBatches: number;
  readonly briefFallback: boolean;
  readonly providerSendMs: number;
  readonly toolMs: number;
  readonly generationMs: number;
  readonly providerOutputTps?: number;
  readonly tokenCoverage: "full_run" | "orchestrator_only";
};

type MutableReviewRunMetricsSnapshot = {
  -readonly [K in keyof ReviewRunMetricsSnapshot]: ReviewRunMetricsSnapshot[K];
};

type ModelTurnMetricEvent = {
  kind: "model_turn";
  usage?: Extract<ReviewMetricEvent, { kind: "model_turn" }>["usage"];
  prompt?: Extract<ReviewMetricEvent, { kind: "model_turn" }>["prompt"];
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
  toolInputRepairs: Record<string, number>;
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
  cacheWrite1hTokens: number | null;
  estimatedTurnCount: number;
  findingsCount: number;
  severities: string[];
  lightweight?: boolean;
  specialistOutcomes: Record<string, number>;
  threadBatches: number;
  briefFallback: boolean;
  toolMs: number;
  providerSendMs: number;
  specialistTokensRecorded: boolean;
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
      meta.startedAtMs != null && Number.isFinite(meta.startedAtMs) ? meta.startedAtMs : Date.now(),
    published: false,
    publishAttempts: 0,
    submitCallCount: 0,
    validationFailureCount: 0,
    validationFailureKinds: {},
    coercionsApplied: {},
    toolInputRepairs: {},
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
    cacheWrite1hTokens: null,
    estimatedTurnCount: 0,
    findingsCount: 0,
    severities: [],
    specialistOutcomes: {},
    threadBatches: 0,
    briefFallback: false,
    toolMs: 0,
    providerSendMs: 0,
    specialistTokensRecorded: false,
  };
}

const metricsByLogger = new WeakMap<RequestLogger, MutableReviewRunMetrics>();

function getOrInitMetrics(meta?: {
  provider: string;
  model: string;
  mode: string;
}): MutableReviewRunMetrics | null {
  const logger = tryUseLogger();
  if (!logger) return null;
  const existing = metricsByLogger.get(logger);
  if (existing) return existing;
  if (!meta) return null;
  const created = createEmptyMetrics(meta);
  metricsByLogger.set(logger, created);
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
    metrics.cacheWrite1hTokens = addKnownCacheTotal(
      metrics.cacheWrite1hTokens,
      usage.cacheWrite1hTokens,
    );
  }
}

export type CacheExcellenceMetrics = {
  readonly cacheHitRate: number | null;
  readonly cacheWriteAmplification: number | null;
};

export function deriveCacheExcellenceMetrics(params: {
  readonly providerInputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}): CacheExcellenceMetrics {
  if (params.cacheReadTokens == null || params.cacheWriteTokens == null) {
    return { cacheHitRate: null, cacheWriteAmplification: null };
  }
  const denominator = params.providerInputTokens + params.cacheReadTokens + params.cacheWriteTokens;
  return {
    cacheHitRate: denominator > 0 ? params.cacheReadTokens / denominator : null,
    cacheWriteAmplification: params.cacheWriteTokens / Math.max(params.cacheReadTokens, 1),
  };
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
      if (event.durationMs != null) metrics.toolMs += event.durationMs;
      if (event.resultBytes != null) metrics.toolResultBytes += event.resultBytes;
      if (event.resultCharacters != null) {
        metrics.toolResultCharacters += event.resultCharacters;
      }
      break;
    case "session_send_span":
      metrics.providerSendMs += event.sendMs;
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
    case "tool_input_repaired":
      for (const repair of event.repairs) {
        bumpRecord(metrics.toolInputRepairs, `${event.tool}:${repair}`);
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

export function recordAgentTurnMetrics(
  turn: AgentRunnerTurn,
  opts?: { readonly specialist?: boolean },
): void {
  const event: ModelTurnMetricEvent = { kind: "model_turn" };
  if (turn.usage) event.usage = turn.usage;
  if (turn.prompt) event.prompt = turn.prompt;
  recordReviewMetric(event);
  if (opts?.specialist) {
    const metrics = getOrInitMetrics();
    if (metrics) metrics.specialistTokensRecorded = true;
  }
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
  if (metricsByLogger.has(logger)) return;
  const created = createEmptyMetrics(meta);
  metricsByLogger.set(logger, created);
  logger.set({ reviewRunMetrics: created });
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
  const generationMs = Math.max(0, metrics.providerSendMs - metrics.toolMs);
  const cacheExcellence = deriveCacheExcellenceMetrics({
    providerInputTokens: metrics.providerInputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
  });
  const snapshot: MutableReviewRunMetricsSnapshot = {
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
    toolInputRepairs: { ...metrics.toolInputRepairs },
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
    cacheWrite1hTokens: metrics.cacheWrite1hTokens,
    cacheHitRate: cacheExcellence.cacheHitRate,
    cacheWriteAmplification: cacheExcellence.cacheWriteAmplification,
    estimatedTurnCount: metrics.estimatedTurnCount,
    findingsCount: metrics.findingsCount,
    severities: [...metrics.severities],
    wallClockMs,
    specialistOutcomes: { ...metrics.specialistOutcomes },
    threadBatches: metrics.threadBatches,
    briefFallback: metrics.briefFallback,
    providerSendMs: metrics.providerSendMs,
    toolMs: metrics.toolMs,
    generationMs,
    tokenCoverage: metrics.specialistTokensRecorded ? "full_run" : "orchestrator_only",
  };
  if (generationMs > 0) {
    snapshot.providerOutputTps = metrics.providerOutputTokens / (generationMs / 1000);
  }
  if (metrics.lightweight !== undefined) snapshot.lightweight = metrics.lightweight;
  return snapshot;
}

export function logReviewRunCompleted(extra?: JsonObject): void {
  const snapshot = snapshotReviewRunMetrics();
  if (!snapshot) return;
  logInfo("review_run_completed", { ...snapshot, ...extra });
}

export function recordClassifiedFailure(failure: ClassifiedFailure): void {
  recordReviewMetric({ kind: "external_failure", failure });
}
