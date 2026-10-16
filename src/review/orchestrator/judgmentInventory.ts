import type {
  FindingInventory,
  InventoryCompleteness,
  InventoryFinding,
} from "../findingIdentity/findingInventory.js";
import type { ReviewFinding } from "../reviewSchema.js";

const PROMPT_INVENTORY_CAP = 150;

export type JudgmentInventory = {
  readonly completeness: InventoryCompleteness;
  readonly json: string;
  readonly count: number;
  readonly omitted: number;
};

type PromptInventoryEntry = {
  readonly findingId: string;
  readonly status: "open" | "fixed" | "dismissed";
  readonly severity: InventoryFinding["severity"];
  readonly lens: InventoryFinding["lens"];
  readonly file: string;
  readonly previousFile?: string;
  readonly line: number | null;
  readonly title: string;
};

function promptEntry(finding: InventoryFinding): PromptInventoryEntry {
  return {
    findingId: finding.id,
    status:
      finding.state === "open" ? "open" : finding.resolution === "fixed" ? "fixed" : "dismissed",
    severity: finding.severity,
    lens: finding.lens,
    file: finding.path,
    ...(finding.previousPath != null ? { previousFile: finding.previousPath } : {}),
    line: finding.line,
    title: finding.title,
  };
}

export function judgmentInventory(
  inventory: FindingInventory,
  reportFindings: readonly Pick<ReviewFinding, "file">[],
): JudgmentInventory {
  const reportFiles = new Set(reportFindings.map((finding) => finding.file));
  const touchesReport = (finding: InventoryFinding) =>
    reportFiles.has(finding.path) ||
    (finding.previousPath != null && reportFiles.has(finding.previousPath));
  const listed = [...inventory.findings.values()]
    .filter((finding) => finding.aliasOf == null)
    .toSorted(
      (a, b) =>
        Number(touchesReport(b)) - Number(touchesReport(a)) ||
        Number(b.state === "open") - Number(a.state === "open") ||
        a.path.localeCompare(b.path) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const shown = listed.slice(0, PROMPT_INVENTORY_CAP).map(promptEntry);
  return {
    completeness: inventory.completeness,
    json: JSON.stringify(shown, null, 2),
    count: shown.length,
    omitted: listed.length - shown.length,
  };
}
