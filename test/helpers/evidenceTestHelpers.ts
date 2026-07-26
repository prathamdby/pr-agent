import {
  createEvidenceLedger,
  hashNormalizedLineText,
  type EvidenceLedger,
} from "../../src/review/findings/evidenceLedger.js";
import type { ReviewFinding } from "../../src/review/reviewSchema.js";

export function createTestEvidenceLedger(headSha = "abc1234"): EvidenceLedger {
  return createEvidenceLedger(headSha);
}

export function seedEvidenceForFinding(
  ledger: EvidenceLedger,
  finding: Pick<ReviewFinding, "file" | "startLine" | "endLine">,
  content = "synthetic evidence slice",
): void {
  ledger.record({
    path: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    contentHash: hashNormalizedLineText(content),
    headSha: ledger.headSha,
    tool: "test",
  });
}

export function seedEvidenceForFindings(
  ledger: EvidenceLedger,
  findings: readonly Pick<ReviewFinding, "file" | "startLine" | "endLine">[],
): void {
  for (const finding of findings) {
    seedEvidenceForFinding(ledger, finding);
  }
}
