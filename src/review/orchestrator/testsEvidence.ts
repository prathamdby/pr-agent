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
) {
  if (finding.testsClaim !== "coverage_gap" || finding.testEvidence == null)
    return ((pinnedReturn: "P0" | "P1" | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: "P0" | "P1" | undefined) => pinnedReturn)(
    finding.testEvidence.criticalPath == null ? "P1" : "P0",
  );
}

export function coverageGapCeilingForFinding(params: {
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
}) {
  if (params.specialist !== "tests")
    return ((pinnedReturn: "P0" | "P1" | undefined) => pinnedReturn)(undefined);
  const gaps = params.reportFindings.filter(
    (row) =>
      row.testsClaim === "coverage_gap" &&
      row.file === params.finding.file &&
      row.startLine === params.finding.startLine &&
      row.endLine === params.finding.endLine &&
      row.title === params.finding.title,
  );
  if (gaps.length === 0)
    return ((pinnedReturn: "P0" | "P1" | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: "P0" | "P1" | undefined) => pinnedReturn)(
    gaps.every((gap) => coverageGapCeiling(gap) === "P0") ? "P0" : "P1",
  );
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
}) {
  const ceiling = coverageGapCeilingForFinding(params);
  if (ceiling == null) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (REVIEW_SEVERITY_RANK[params.finding.severity] < REVIEW_SEVERITY_RANK[ceiling]) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      `coverage gap severity ${params.finding.severity} is above the ${ceiling} ceiling`,
    );
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

export function testsFindingError(params: {
  readonly specialist: SpecialistId;
  readonly findings: readonly TestsEvidenceFinding[];
  readonly cwd: string;
  readonly ledger: EvidenceLedger | undefined;
  readonly requireContentRead: boolean;
}) {
  if (params.specialist !== "tests")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  for (const finding of params.findings) {
    const error = coverageGapError(finding, params);
    if (error != null) return ((pinnedReturn: string | undefined) => pinnedReturn)(error);
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

function coverageGapError(
  finding: TestsEvidenceFinding,
  params: {
    readonly cwd: string;
    readonly ledger: EvidenceLedger | undefined;
    readonly requireContentRead: boolean;
  },
) {
  if (finding.testsClaim == null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      "A tests finding requires testsClaim.",
    );
  if (finding.testsClaim !== "coverage_gap")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const evidence = finding.testEvidence;
  if (evidence == null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      "A coverage_gap finding requires testEvidence.",
    );
  const shapeError = gapShapeError(evidence);
  if (shapeError != null) return ((pinnedReturn: string | undefined) => pinnedReturn)(shapeError);
  if (finding.suggestedSeverity === "P0" && evidence.criticalPath == null) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      "A coverage gap without criticalPath has ceiling P1.",
    );
  }
  for (const path of evidence.read) {
    const pathError = readPathError(params.cwd, path);
    if (pathError != null) return ((pinnedReturn: string | undefined) => pinnedReturn)(pathError);
    if (!params.requireContentRead) continue;
    if (params.ledger != null && hasContentRead(params.ledger, path)) continue;
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      `read path has no content read in this run: ${path}`,
    );
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

function gapShapeError(evidence: TestEvidence) {
  if (evidence.read.length === 0) {
    if (evidence.gap !== NO_CANDIDATE_TEST_GAP) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `When read is empty, gap must be ${NO_CANDIDATE_TEST_GAP}`,
      );
    }
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  }
  if (evidence.gap === NO_CANDIDATE_TEST_GAP) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      "When read lists paths, gap names the missed neighbor.",
    );
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

function readPathError(cwd: string, requestedPath: string) {
  try {
    assertWorkspacePath(cwd, requestedPath);
  } catch (error) {
    if (error instanceof AppError && error.kind === "path_traversal") {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `read path is outside the workspace: ${requestedPath}`,
      );
    }
    throw error;
  }
  if (isSensitivePath(requestedPath))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      `read path is sensitive: ${requestedPath}`,
    );
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

function hasContentRead(ledger: EvidenceLedger, requestedPath: string) {
  const path = normalizeEvidencePath(requestedPath);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    ledger.snapshot().some((read) => read.path === path),
  );
}
