import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.ts";
import type { ReviewFinding } from "../reviewSchema.ts";
import { normalizeEvidencePath, type EvidenceLedger } from "./evidenceLedger.ts";

type EvidenceAnchor = Pick<ReviewFinding, "file" | "startLine" | "endLine">;

export type EvidenceRejectedFinding<T extends EvidenceAnchor = ReviewFinding> = {
  readonly finding: T;
  readonly reasonCode: string;
};

export function assertFindingsHaveEvidence<T extends EvidenceAnchor>(
  findings: readonly T[],
  ledger: EvidenceLedger,
  headSha: string,
  opts?: {
    readonly checkoutCoverage?: CheckoutCoverage;
    readonly isPathInCheckout?: (path: string) => boolean;
  },
): { accepted: T[]; rejected: EvidenceRejectedFinding<T>[] } {
  const accepted: T[] = [];
  const rejected: EvidenceRejectedFinding<T>[] = [];

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
