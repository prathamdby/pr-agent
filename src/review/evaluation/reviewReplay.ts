import { createHash } from "node:crypto";
import { z } from "zod";
import { logInfo, logWarn } from "../../evlog.js";
import type { ReviewFinding } from "../reviewSchema.js";
import {
  compareFindings,
  evaluateGates,
  normalizeFinding,
  type AdjudicatedFinding,
  type ComparisonResult,
  type GateResult,
  type NormalizedFinding,
} from "./reviewComparison.js";

/** A PR snapshot fixture for replay evaluation. */
export type ReplayCaseSnapshot = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly patch: string;
  }[];
  readonly contentHash: string;
};

/** A single adjudicated replay case from the manifest. */
export type ReplayCase = {
  readonly caseId: string;
  readonly domain: string;
  readonly sizeTag: "small" | "medium" | "large";
  readonly snapshot: ReplayCaseSnapshot;
  readonly expectedFindings: readonly AdjudicatedFinding[];
  readonly acceptedClean: boolean;
};

/** Versioned replay manifest schema. */
export const replayManifestSchema = z.object({
  version: z.literal(1),
  cases: z
    .array(
      z.object({
        caseId: z.string().min(1),
        domain: z.enum(["correctness", "security", "reliability", "change-safety"]),
        sizeTag: z.enum(["small", "medium", "large"]),
        snapshot: z.object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          prNumber: z.number().int().positive(),
          headSha: z.string().min(1),
          baseSha: z.string().min(1),
          files: z
            .array(
              z.object({
                path: z.string().min(1),
                status: z.string().min(1),
                patch: z.string(),
              }),
            )
            .min(1),
          contentHash: z.string().min(1),
        }),
        expectedFindings: z.array(
          z.object({
            id: z.string().min(1),
            file: z.string().min(1),
            lineBucket: z.number().int().nonnegative(),
            normalizedTitle: z.string().min(1),
            severity: z.enum(["P0", "P1", "P2", "P3"]),
            valid: z.boolean(),
          }),
        ),
        acceptedClean: z.boolean(),
      }),
    )
    .min(1),
});

export type ReplayManifest = z.infer<typeof replayManifestSchema>;

export type ReplayCaseResult = {
  readonly caseId: string;
  readonly legacyFindings: readonly NormalizedFinding[];
  readonly hybridFindings: readonly NormalizedFinding[];
  readonly comparison: ComparisonResult;
  readonly legacyDurationMs: number;
  readonly hybridDurationMs: number;
};

export type ReplayReport = {
  readonly caseResults: readonly ReplayCaseResult[];
  readonly gate: GateResult;
  readonly totalCases: number;
};

/** Compute the deterministic content hash for a snapshot fixture. */
export function computeSnapshotContentHash(snapshot: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly patch: string;
  }[];
}): string {
  const canonical = JSON.stringify({
    owner: snapshot.owner,
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    files: snapshot.files.map((f) => ({ path: f.path, status: f.status, patch: f.patch })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Validate a replay manifest. Rejects missing expected outcomes, unknown critic
 * domains, duplicate case IDs, or snapshots whose recorded hashes do not match
 * fixture content.
 */
export function validateManifest(manifest: unknown): ReplayManifest {
  const parsed = replayManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`Invalid replay manifest: ${parsed.error.message}`);
  }
  const valid = parsed.data;
  const seenIds = new Set<string>();
  for (const caseEntry of valid.cases) {
    if (seenIds.has(caseEntry.caseId)) {
      throw new Error(`Duplicate replay case ID: ${caseEntry.caseId}`);
    }
    seenIds.add(caseEntry.caseId);

    if (!caseEntry.acceptedClean && caseEntry.expectedFindings.length === 0) {
      throw new Error(
        `Replay case ${caseEntry.caseId} has no expected findings and is not acceptedClean`,
      );
    }

    const computedHash = computeSnapshotContentHash(caseEntry.snapshot);
    if (computedHash !== caseEntry.snapshot.contentHash) {
      throw new Error(
        `Replay case ${caseEntry.caseId} content hash mismatch: expected ${caseEntry.snapshot.contentHash}, got ${computedHash}`,
      );
    }
  }
  return valid;
}

/** Run one replay case through both pipelines via a publication-free evaluation boundary. */
export async function runReplayCase(params: {
  readonly caseEntry: ReplayCase;
  readonly runLegacy: (
    snapshot: ReplayCaseSnapshot,
  ) => Promise<{ findings: readonly ReviewFinding[]; durationMs: number }>;
  readonly runHybrid: (
    snapshot: ReplayCaseSnapshot,
  ) => Promise<{ findings: readonly ReviewFinding[]; durationMs: number }>;
}): Promise<ReplayCaseResult> {
  const { caseEntry, runLegacy, runHybrid } = params;
  const [legacySettled, hybridSettled] = await Promise.allSettled([
    runLegacy(caseEntry.snapshot),
    runHybrid(caseEntry.snapshot),
  ]);
  if (legacySettled.status === "rejected") {
    const message =
      legacySettled.reason instanceof Error
        ? legacySettled.reason.message
        : String(legacySettled.reason);
    logWarn("replay_legacy_failed", { caseId: caseEntry.caseId, message });
    throw new Error(`Replay legacy runner failed for case ${caseEntry.caseId}: ${message}`);
  }
  if (hybridSettled.status === "rejected") {
    const message =
      hybridSettled.reason instanceof Error
        ? hybridSettled.reason.message
        : String(hybridSettled.reason);
    logWarn("replay_hybrid_failed", { caseId: caseEntry.caseId, message });
    throw new Error(`Replay hybrid runner failed for case ${caseEntry.caseId}: ${message}`);
  }
  const legacyResult = legacySettled.value;
  const hybridResult = hybridSettled.value;

  const legacyFindings = legacyResult.findings.map(normalizeFinding);
  const hybridFindings = hybridResult.findings.map(normalizeFinding);
  const comparison = compareFindings({
    legacy: legacyFindings,
    hybrid: hybridFindings,
    adjudicated: caseEntry.expectedFindings,
  });

  return {
    caseId: caseEntry.caseId,
    legacyFindings,
    hybridFindings,
    comparison,
    legacyDurationMs: legacyResult.durationMs,
    hybridDurationMs: hybridResult.durationMs,
  };
}

/** Run the full replay corpus and evaluate launch gates. */
export async function runReplay(params: {
  readonly manifest: ReplayManifest;
  readonly runLegacy: (
    snapshot: ReplayCaseSnapshot,
  ) => Promise<{ findings: readonly ReviewFinding[]; durationMs: number }>;
  readonly runHybrid: (
    snapshot: ReplayCaseSnapshot,
  ) => Promise<{ findings: readonly ReviewFinding[]; durationMs: number }>;
  readonly shadowReviewCount?: number;
  readonly shadowDays?: number;
}): Promise<ReplayReport> {
  const caseResults: ReplayCaseResult[] = [];
  for (const caseEntry of params.manifest.cases) {
    const result = await runReplayCase({
      caseEntry,
      runLegacy: params.runLegacy,
      runHybrid: params.runHybrid,
    });
    caseResults.push(result);
  }

  const allAdjudicated = params.manifest.cases.flatMap((c) => c.expectedFindings);
  const allEntries = caseResults.flatMap((r) => r.comparison.entries);
  const aggregateComparison: ComparisonResult = {
    entries: allEntries,
    legacyCount: caseResults.reduce((sum, r) => sum + r.comparison.legacyCount, 0),
    hybridCount: caseResults.reduce((sum, r) => sum + r.comparison.hybridCount, 0),
    matchedCount: caseResults.reduce((sum, r) => sum + r.comparison.matchedCount, 0),
    legacyOnlyCount: caseResults.reduce((sum, r) => sum + r.comparison.legacyOnlyCount, 0),
    hybridOnlyCount: caseResults.reduce((sum, r) => sum + r.comparison.hybridOnlyCount, 0),
  };

  const gate = evaluateGates({
    comparison: aggregateComparison,
    adjudicated: allAdjudicated,
    legacyCaseCount: caseResults.length,
    shadowReviewCount: params.shadowReviewCount,
    shadowDays: params.shadowDays,
  });

  logInfo("replay_report", {
    totalCases: caseResults.length,
    gate: gate.details,
    recallPass: gate.recallPass,
    falsePositivePass: gate.falsePositivePass,
  });

  return {
    caseResults,
    gate,
    totalCases: caseResults.length,
  };
}
