import {
  capFindingDetail,
  type FindingInventory,
  type InventoryCompleteness,
  type InventoryFinding,
} from "../findingIdentity/findingInventory.js";
import type { ReviewFinding } from "../reviewSchema.js";
import type { AcceptedPlacement } from "./orchestratorTypes.js";

const PROMPT_INVENTORY_CAP = 150;

export type JudgmentInventory = {
  readonly completeness: InventoryCompleteness;
  readonly json: string;
  readonly count: number;
  readonly omitted: number;
};

type PromptInventoryEntry = {
  readonly findingId: string;
  readonly status: "open" | "fixed" | "dismissed" | "accepted_this_run";
  readonly severity: InventoryFinding["severity"];
  readonly lens: InventoryFinding["lens"];
  readonly file: string;
  readonly previousFile?: string;
  readonly line: number | null;
  readonly title: string;
  readonly detail?: string;
};

function promptEntry(finding: InventoryFinding, includeDetail: boolean): PromptInventoryEntry {
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
    ...(includeDetail && finding.detail != null ? { detail: finding.detail } : {}),
  };
}

function isLive(entry: PromptInventoryEntry): boolean {
  return entry.status === "open" || entry.status === "accepted_this_run";
}

function acceptedEntry(accepted: AcceptedPlacement): PromptInventoryEntry {
  const { finding } = accepted.placement;
  const detail = capFindingDetail(finding.detail);
  return {
    findingId: accepted.findingId,
    status: "accepted_this_run",
    severity: finding.severity,
    lens: accepted.source,
    file: finding.file,
    line: finding.startLine,
    title: finding.title,
    ...(detail != null ? { detail } : {}),
  };
}

export function judgmentInventory(
  inventory: FindingInventory,
  reportFindings: readonly Pick<ReviewFinding, "file">[],
  acceptedThisRun: readonly AcceptedPlacement[] = [],
): JudgmentInventory {
  const reportFiles = new Set(reportFindings.map((finding) => finding.file));
  const touchesReport = (entry: PromptInventoryEntry) =>
    reportFiles.has(entry.file) ||
    (entry.previousFile != null && reportFiles.has(entry.previousFile));
  const fromRun = acceptedThisRun
    .filter((accepted) => !inventory.findings.has(accepted.findingId))
    .map(acceptedEntry);
  const listed = [
    ...[...inventory.findings.values()]
      .filter((finding) => finding.aliasOf == null)
      .map((finding) =>
        promptEntry(
          finding,
          finding.state === "open" &&
            (reportFiles.has(finding.path) ||
              (finding.previousPath != null && reportFiles.has(finding.previousPath))),
        ),
      ),
    ...fromRun,
  ].toSorted(
    (a, b) =>
      Number(touchesReport(b)) - Number(touchesReport(a)) ||
      Number(isLive(b)) - Number(isLive(a)) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.findingId.localeCompare(b.findingId),
  );
  const shown = listed.slice(0, PROMPT_INVENTORY_CAP);
  return {
    completeness: inventory.completeness,
    json: JSON.stringify(shown, null, 2),
    count: shown.length,
    omitted: listed.length - shown.length,
  };
}
