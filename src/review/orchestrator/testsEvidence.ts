import { isSensitivePath } from "../../agent/ask/askSafety.ts";
import { AppError } from "../../errors/appError.ts";
import { assertWorkspacePath } from "../../prWorkspace/repositoryReader.ts";
import { normalizeEvidencePath, type EvidenceLedger } from "../findings/evidenceLedger.ts";
import { REVIEW_SEVERITY_RANK } from "../../settings/index.ts";
import type { SpecialistId } from "./orchestratorTypes.ts";
import { NO_CANDIDATE_TEST_GAP } from "../../prompts/tests/prompt.ts";

export { NO_CANDIDATE_TEST_GAP };

export const TESTS_CLAIMS = ["coverage_gap", "invalidated_test"] as const;
export const CRITICAL_PATHS = ["money", "data_integrity", "correctness"] as const;

export type TestsClaim = (typeof TESTS_CLAIMS)[number];
export type CriticalPath = (typeof CRITICAL_PATHS)[number];

export type TestEvidence = {
  readonly searched: readonly string[];
  readonly read: readonly string[];
  readonly gap: string;
  readonly criticalPath?: CriticalPath;
};

export type TestsEvidenceFinding = {
  readonly suggestedSeverity: "P0" | "P1" | "P2" | "P3";
  readonly testsClaim?: TestsClaim;
  readonly testEvidence?: TestEvidence;
};

export function coverageGapCeiling(
  finding: Pick<TestsEvidenceFinding, "testsClaim" | "testEvidence">,
): "P0" | "P1" | undefined {
  if (finding.testsClaim !== "coverage_gap" || finding.testEvidence == null) return undefined;
  return finding.testEvidence.criticalPath == null ? "P1" : "P0";
}

export function coverageGapPublishError(params: {
  readonly specialist: SpecialistId;
  readonly reportFindings: readonly (TestsEvidenceFinding & {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly title: string;
  })[];
  readonly finding: {
    readonly severity: "P0" | "P1" | "P2" | "P3";
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly title: string;
  };
}): string | undefined {
  if (params.specialist !== "tests") return undefined;
  const gaps = params.reportFindings.filter(
    (row) =>
      row.testsClaim === "coverage_gap" &&
      row.file === params.finding.file &&
      row.startLine === params.finding.startLine &&
      row.endLine === params.finding.endLine &&
      row.title === params.finding.title,
  );
  if (gaps.length === 0) return undefined;
  const ceiling = gaps.every((gap) => coverageGapCeiling(gap) === "P0") ? "P0" : "P1";
  if (REVIEW_SEVERITY_RANK[params.finding.severity] < REVIEW_SEVERITY_RANK[ceiling]) {
    return `coverage gap severity ${params.finding.severity} is above the ${ceiling} ceiling`;
  }
  return undefined;
}

export function isCoverageGapRow(params: {
  readonly specialist: SpecialistId;
  readonly reportFindings: readonly (TestsEvidenceFinding & {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly title: string;
  })[];
  readonly finding: {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly title: string;
  };
}): boolean {
  return (
    params.specialist === "tests" &&
    params.reportFindings.some(
      (row) =>
        row.testsClaim === "coverage_gap" &&
        row.file === params.finding.file &&
        row.startLine === params.finding.startLine &&
        row.endLine === params.finding.endLine &&
        row.title === params.finding.title,
    )
  );
}

export function testsFindingError(params: {
  readonly specialist: SpecialistId;
  readonly findings: readonly TestsEvidenceFinding[];
  readonly cwd: string;
  readonly ledger: EvidenceLedger | undefined;
  readonly requireContentRead: boolean;
}): string | undefined {
  if (params.specialist !== "tests") return undefined;
  for (const finding of params.findings) {
    const error = coverageGapError(finding, params);
    if (error != null) return error;
  }
  return undefined;
}

function coverageGapError(
  finding: TestsEvidenceFinding,
  params: {
    readonly cwd: string;
    readonly ledger: EvidenceLedger | undefined;
    readonly requireContentRead: boolean;
  },
): string | undefined {
  if (finding.testsClaim == null) return "A tests finding requires testsClaim.";
  if (finding.testsClaim !== "coverage_gap") return undefined;
  const evidence = finding.testEvidence;
  if (evidence == null) return "A coverage_gap finding requires testEvidence.";
  const shapeError = gapShapeError(evidence);
  if (shapeError != null) return shapeError;
  if (finding.suggestedSeverity === "P0" && evidence.criticalPath == null) {
    return "A coverage gap without criticalPath has ceiling P1.";
  }
  for (const path of evidence.read) {
    const pathError = readPathError(params.cwd, path);
    if (pathError != null) return pathError;
    if (!params.requireContentRead) continue;
    if (params.ledger != null && hasContentRead(params.ledger, path)) continue;
    return `read path has no content read in this run: ${path}`;
  }
  return undefined;
}

function gapShapeError(evidence: TestEvidence): string | undefined {
  if (evidence.read.length === 0) {
    if (evidence.gap !== NO_CANDIDATE_TEST_GAP) {
      return `When read is empty, gap must be ${NO_CANDIDATE_TEST_GAP}`;
    }
    return undefined;
  }
  if (evidence.gap === NO_CANDIDATE_TEST_GAP) {
    return "When read lists paths, gap names the missed neighbor.";
  }
  return undefined;
}

function readPathError(cwd: string, requestedPath: string): string | undefined {
  try {
    assertWorkspacePath(cwd, requestedPath);
  } catch (error) {
    if (error instanceof AppError && error.kind === "path_traversal") {
      return `read path is outside the workspace: ${requestedPath}`;
    }
    throw error;
  }
  if (isSensitivePath(requestedPath)) return `read path is sensitive: ${requestedPath}`;
  return undefined;
}

function hasContentRead(ledger: EvidenceLedger, requestedPath: string): boolean {
  const path = normalizeEvidencePath(requestedPath);
  return ledger.snapshot().some((read) => read.path === path);
}
