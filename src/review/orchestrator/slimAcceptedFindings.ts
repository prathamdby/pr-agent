import type {
  AcceptedFindingSlimReference,
  AcceptedPlacement,
  FindingLedger,
  SpecialistId,
} from "./orchestratorTypes.js";
import type { ReviewFinding } from "../reviewSchema.js";
import type { SpecialistReport } from "./specialistReport.js";
import { fingerprintCandidates } from "../findings/reviewFindingFingerprint.js";

type ReportOutcome = {
  readonly specialist: SpecialistId;
  readonly report: SpecialistReport;
};

export function slimAcceptedFindings(
  outcome: ReportOutcome,
  ledger: FindingLedger,
): { readonly json: string; readonly count: number } {
  const findings = outcome.report.findings;
  if (findings.length === 0) return { json: JSON.stringify(outcome.report, null, 2), count: 0 };
  const acceptedByFingerprint = new Map<string, AcceptedPlacement[]>();
  for (const placement of ledger.accepted) {
    if (placement.kind === "posted" || placement.kind === "resumed") {
      const existing = acceptedByFingerprint.get(placement.canonicalFingerprint);
      if (existing) {
        existing.push(placement);
      } else {
        acceptedByFingerprint.set(placement.canonicalFingerprint, [placement]);
      }
    }
  }
  let count = 0;
  const slimmed: readonly (ReviewFinding | AcceptedFindingSlimReference)[] = findings.map(
    (finding) => {
      const findingId =
        fingerprintCandidates(finding).find((candidate) =>
          acceptedByFingerprint
            .get(candidate)
            ?.some(
              (placement) =>
                placement.placement.finding.file === finding.file &&
                placement.placement.finding.startLine === finding.startLine,
            ),
        ) ?? null;
      if (findingId == null) return finding;
      count += 1;
      return {
        findingId,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
      };
    },
  );
  if (count === 0) return { json: JSON.stringify(outcome.report, null, 2), count: 0 };
  return { json: JSON.stringify({ ...outcome.report, findings: slimmed }, null, 2), count };
}
