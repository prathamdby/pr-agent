import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";
import type { ReviewFinding } from "../reviewSchema.js";
import { normalizeEvidencePath, type EvidenceLedger } from "./evidenceLedger.js";

export type EvidenceRejectedFinding = {
  readonly finding: ReviewFinding;
  readonly reasonCode: string;
};

export type EvidenceValidationResult = {
  readonly accepted: ReviewFinding[];
  readonly rejected: EvidenceRejectedFinding[];
};

export function assertFindingsHaveEvidence(
  findings: readonly ReviewFinding[],
  ledger: EvidenceLedger,
  headSha: string,
  opts?: {
    readonly checkoutCoverage?: CheckoutCoverage;
    readonly isPathInCheckout?: (path: string) => boolean;
  },
): EvidenceValidationResult {
  const accepted: ReviewFinding[] = [];
  const rejected: EvidenceRejectedFinding[] = [];

  for (const finding of findings) {
    if (ledger.covers(finding.file, finding.startLine, finding.endLine)) {
      accepted.push(finding);
      continue;
    }

    const path = normalizeEvidencePath(finding.file);
    const sparseWithoutCheckout =
      opts?.checkoutCoverage?.mode === "sparse" &&
      opts.isPathInCheckout != null &&
      !opts.isPathInCheckout(path);

    rejected.push({
      finding,
      reasonCode: sparseWithoutCheckout ? "sparse_path_no_evidence" : "no_evidence",
    });
  }

  return { accepted, rejected };
}
