import type {
  AcceptedFindingSlimReference,
  FindingLedger,
  SpecialistId,
} from "./orchestratorTypes.ts";
import type { ReviewFinding } from "../reviewSchema.ts";
import type { SpecialistReport } from "./specialistReport.ts";

type ReportOutcome = {
  readonly specialist: SpecialistId;
  readonly report: SpecialistReport;
};

function samePublishedFinding(left: ReviewFinding, right: ReviewFinding): boolean {
  return (
    left.file === right.file &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine &&
    left.title === right.title &&
    left.detail === right.detail
  );
}

export function slimAcceptedFindings(
  outcome: ReportOutcome,
  ledger: FindingLedger,
): { readonly json: string; readonly count: number } {
  const findings = outcome.report.findings;
  if (findings.length === 0) return { json: JSON.stringify(outcome.report, null, 2), count: 0 };
  const published = ledger.accepted.filter(
    (placement) => placement.kind === "posted" || placement.kind === "resumed",
  );
  let count = 0;
  const slimmed: readonly (ReviewFinding | AcceptedFindingSlimReference)[] = findings.map(
    (finding) => {
      const match = published.find((placement) =>
        samePublishedFinding(placement.placement.finding, finding),
      );
      if (match == null) return finding;
      count += 1;
      return {
        findingId: match.findingId,
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
