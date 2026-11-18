import {
  createEvidenceLedger,
  hashNormalizedLineText,
  type EvidenceLedger,
} from "../../src/review/findings/evidenceLedger.ts";
import type { ReviewFinding } from "../../src/review/reviewSchema.ts";

export function createTestEvidenceLedger(headSha = "abc1234") {
  return ((pinnedReturn: EvidenceLedger) => pinnedReturn)(createEvidenceLedger(headSha));
}

export function seedEvidenceForFinding(
  ledger: EvidenceLedger,
  finding: Pick<ReviewFinding, "file" | "startLine" | "endLine">,
  content = "synthetic evidence slice",
) {
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
) {
  for (const finding of findings) {
    seedEvidenceForFinding(ledger, finding);
  }
}
