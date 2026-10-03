import type { ReviewFinding } from "../reviewSchema.js";
import type { EvidenceDescriptor, EvidenceLedger } from "../findings/evidenceLedger.js";

/** Diff-only and response-only legacy evidence cannot reproduce saved coverage. */
export function evidenceForCachedFindings(
  ledger: EvidenceLedger,
  findings: readonly ReviewFinding[],
): EvidenceDescriptor[] | null {
  const evidence = ledger.snapshot().flatMap((read) => (read.descriptor ? [read.descriptor] : []));
  const selected = new Map<string, EvidenceDescriptor>();
  for (const finding of findings) {
    const read = evidence.find(
      (entry) =>
        entry.headSha === ledger.headSha &&
        entry.path === finding.file &&
        entry.startLine <= finding.startLine &&
        entry.endLine >= finding.endLine,
    );
    if (!read) return null;
    selected.set(JSON.stringify(read), read);
  }
  return [...selected.values()];
}
