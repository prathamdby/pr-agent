import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  AgentRunnerProvider,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import {
  buildBatchValidatorSystemPrompt,
  buildBatchValidatorUserContent,
} from "../prompts/validatorPrompt.js";
import type { CriticId, CriticReport } from "./reviewCritics.js";
import { CRITIC_IDS } from "./reviewCritics.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import { sendReviewAgentTurn } from "./reviewRunAgentSend.js";
import type { ReviewSessionRegistry } from "./reviewSessionRegistry.js";
import { createReviewToolCallRecorder } from "./reviewToolCallRecorder.js";

export type ValidationVerdict = "confirmed" | "refuted" | "unverifiable";

export type ValidationCandidate = {
  /** Stable batch ID assigned before the validator call (KTD7). */
  readonly id: string;
  readonly critic: CriticId;
  readonly findingIndex: number;
  readonly finding: CriticReport["findings"][number];
};

const batchVerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string().min(1),
        verdict: z.enum(["confirmed", "refuted", "unverifiable"]),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(256),
});

/** Deterministic candidate order: critic order, then finding index. */
export function collectHighRiskCandidates(reports: readonly CriticReport[]): ValidationCandidate[] {
  const ordered = [...reports].toSorted(
    (a, b) => CRITIC_IDS.indexOf(a.critic) - CRITIC_IDS.indexOf(b.critic),
  );
  const candidates: ValidationCandidate[] = [];
  for (const report of ordered) {
    report.findings.forEach((finding, findingIndex) => {
      if (finding.severity !== "P0" && finding.severity !== "P1") return;
      candidates.push({
        id: `c${candidates.length + 1}`,
        critic: report.critic,
        findingIndex,
        finding,
      });
    });
  }
  return candidates;
}

export type BatchValidationResult = {
  readonly verdictById: ReadonlyMap<string, ValidationVerdict>;
  /** True when the validator session failed and every candidate stayed unvalidated. */
  readonly failedOpen: boolean;
};

/**
 * Run at most one batched validator session. Missing, malformed, duplicate, or
 * unknown-ID verdicts leave candidates `unverifiable`; only explicit `refuted`
 * verdicts can remove a candidate (R12, R13).
 */
export async function runBatchValidation(params: {
  cfg: Config;
  runner: AgentRunnerProvider;
  cwd?: string;
  candidates: readonly ValidationCandidate[];
  investigationTools: {
    readonly piTools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  refreshBeforeTool?: (toolName: string) => Promise<void>;
  signal?: AbortSignal;
  registry: ReviewSessionRegistry;
}): Promise<BatchValidationResult> {
  const startedAt = Date.now();
  const verdictById = new Map<string, ValidationVerdict>();
  for (const candidate of params.candidates) {
    verdictById.set(candidate.id, "unverifiable");
  }
  if (params.candidates.length === 0) return { verdictById, failedOpen: false };

  const knownIds = new Set(params.candidates.map((candidate) => candidate.id));
  let submitted: z.infer<typeof batchVerdictSchema> | undefined;
  const submitTool: PiTool = {
    name: "submitValidationBatch",
    description: "Submit one verdict (confirmed, refuted, or unverifiable) per candidate ID.",
    parameters: z.toJSONSchema(batchVerdictSchema, {
      unrepresentable: "any",
    }) as PiTool["parameters"],
  };

  let failedOpen = false;
  try {
    const session = await params.runner.createSession({
      cfg: params.cfg,
      cwd: params.cwd,
      signal: params.signal,
      systemPrompt: buildBatchValidatorSystemPrompt(),
      tools: [...params.investigationTools.piTools, submitTool],
      executors: {
        ...params.investigationTools.executors,
        submitValidationBatch: async (args) => {
          submitted = batchVerdictSchema.parse(args);
          return { ok: true };
        },
      },
      refreshBeforeTool: params.refreshBeforeTool,
      onToolCallMetric: createReviewToolCallRecorder("validator"),
    });
    const unregister = params.registry.register(session);
    try {
      await sendReviewAgentTurn(
        session,
        buildBatchValidatorUserContent(params.candidates),
        { maxToolRounds: params.cfg.maxToolRoundsValidator, signal: params.signal },
        "validator",
      );
    } finally {
      unregister();
      await session.dispose();
    }
  } catch (error) {
    if (!params.signal?.aborted) {
      failedOpen = true;
      logWarn("review_batch_validation_failed_open", {
        session_role: "validator",
        candidate_count: params.candidates.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const seen = new Set<string>();
  for (const entry of submitted?.verdicts ?? []) {
    if (!knownIds.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    verdictById.set(entry.id, entry.verdict);
  }

  const droppedCount = [...verdictById.values()].filter((verdict) => verdict === "refuted").length;
  recordReviewMetric({
    kind: "validation_stage_completed",
    candidateCount: params.candidates.length,
    truncatedCandidates: 0,
    droppedCount,
    durationMs: Date.now() - startedAt,
  });
  return { verdictById, failedOpen };
}

export type ValidatedCriticReports = {
  readonly reports: CriticReport[];
  readonly removedCount: number;
  readonly unvalidatedCount: number;
};

/** Remove only explicitly refuted candidates; everything else survives with its state. */
export function applyValidationVerdicts(
  reports: readonly CriticReport[],
  candidates: readonly ValidationCandidate[],
  verdictById: ReadonlyMap<string, ValidationVerdict>,
): ValidatedCriticReports {
  const refuted = new Set<string>();
  let unvalidatedCount = 0;
  for (const candidate of candidates) {
    const verdict = verdictById.get(candidate.id) ?? "unverifiable";
    if (verdict === "refuted") {
      refuted.add(`${candidate.critic}:${candidate.findingIndex}`);
    } else if (verdict === "unverifiable") {
      unvalidatedCount += 1;
    }
  }
  return {
    reports: reports.map((report) => ({
      ...report,
      findings: report.findings.filter(
        (_finding, findingIndex) => !refuted.has(`${report.critic}:${findingIndex}`),
      ),
    })),
    removedCount: refuted.size,
    unvalidatedCount,
  };
}
