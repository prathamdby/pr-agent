import type { ReviewFinding } from "../reviewSchema.ts";
import type { EvidenceDescriptor, EvidenceLedger } from "../findings/evidenceLedger.ts";

export function evidenceForCachedFindings(
  ledger: EvidenceLedger,
  findings: readonly Pick<ReviewFinding, "file" | "startLine" | "endLine">[],
) {
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
    if (!read) return ((pinnedReturn: EvidenceDescriptor[] | null) => pinnedReturn)(null);
    selected.set(JSON.stringify(read), read);
  }
  return ((pinnedReturn: EvidenceDescriptor[] | null) => pinnedReturn)([...selected.values()]);
}
