import type {
  AcceptedFindingSlimReference,
  FindingLedger,
  SpecialistId,
} from "./orchestratorTypes.ts";
import type { ReviewFinding } from "../reviewSchema.ts";
import type { SpecialistReport } from "./specialistReport.ts";
import { awaitingCandidates, type AwaitingCandidate } from "./judgmentDisposition.ts";

type ReportOutcome = {
  readonly specialist: SpecialistId;
  readonly report: SpecialistReport;
};

function samePublishedFinding(
  left: Pick<ReviewFinding, "file" | "startLine" | "endLine" | "title" | "detail">,
  right: Pick<ReviewFinding, "file" | "startLine" | "endLine" | "title" | "detail">,
): boolean {
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
): {
  readonly json: string;
  readonly count: number;
  readonly awaiting: readonly AwaitingCandidate[];
} {
  const findings = outcome.report.findings;
  const awaiting = awaitingCandidates(outcome.specialist, outcome.report, ledger);
  if (findings.length === 0) {
    return { json: JSON.stringify(outcome.report, null, 2), count: 0, awaiting };
  }
  const published = ledger.accepted.filter(
    (placement) => placement.kind === "posted" || placement.kind === "resumed",
  );
  let count = 0;
  const slimmed: readonly (SpecialistReport["findings"][number] | AcceptedFindingSlimReference)[] =
    findings.map((finding) => {
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
    });
  if (count === 0) return { json: JSON.stringify(outcome.report, null, 2), count: 0, awaiting };
  return {
    json: JSON.stringify({ ...outcome.report, findings: slimmed }, null, 2),
    count,
    awaiting,
  };
}
