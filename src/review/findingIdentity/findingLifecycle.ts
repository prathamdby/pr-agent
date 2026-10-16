import {
  escapeTableHtml,
  renderKeyValueTable,
  renderTableLink,
  renderTableLocationMeta,
  renderTableStrong,
} from "../../github/markdownFormat.js";
import type { FindingLedger } from "../orchestrator/orchestratorTypes.js";
import { isCheckFailingSeverity } from "../reviewSchema.js";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../statusCopy.js";
import type {
  FindingInventory,
  InventoryCompleteness,
  InventoryFinding,
} from "./findingInventory.js";
import { renderFindingRowMarker, type FindingId, type FindingSeverity } from "./findingMarker.js";

export type FindingStatus =
  | "new"
  | "confirmed_at_head"
  | "open_unverified"
  | "outdated_location"
  | "summary_only";

export type CleanedDuplicate = {
  readonly id: FindingId;
  readonly canonicalUrl: string;
  readonly resolved: boolean;
};

export type FindingRunOutcomes =
  | {
      readonly kind: "reviewed";
      readonly ledger: Pick<FindingLedger, "accepted" | "reaffirmed" | "suppressedDismissedCount">;
      readonly duplicates: readonly CleanedDuplicate[];
    }
  | { readonly kind: "not_reviewed" };

export type FindingViewRow = {
  readonly id: FindingId;
  readonly status: FindingStatus;
  readonly severity: FindingSeverity | "unknown";
  readonly blocking: boolean;
  readonly held: InventoryFinding | null;
  readonly observedThisRun: boolean;
};

export type FindingView = {
  readonly completeness: InventoryCompleteness;
  readonly rows: readonly FindingViewRow[];
  readonly blockingCount: number;
  readonly suppressedDismissedCount: number;
  readonly duplicates: readonly CleanedDuplicate[];
};

export type FindingCheckConclusion = "failure" | "neutral" | "success";

export type FindingCheck = {
  readonly conclusion: FindingCheckConclusion;
  readonly blockingCount: number;
};

const SEVERITY_ORDER: readonly (FindingSeverity | "unknown")[] = [
  "P0",
  "P1",
  "P2",
  "P3",
  "unknown",
];
const CARRIED_TITLE_MAX_CHARS = 80;

function severityRank(severity: FindingSeverity | "unknown"): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function higherSeverity(
  left: FindingSeverity | "unknown",
  right: FindingSeverity | "unknown",
): FindingSeverity | "unknown" {
  return severityRank(left) <= severityRank(right) ? left : right;
}

function viewRow(
  id: FindingId,
  status: FindingStatus,
  severity: FindingSeverity | "unknown",
  held: InventoryFinding | null,
  observedThisRun: boolean,
): FindingViewRow {
  return {
    id,
    status,
    severity,
    blocking: severity !== "unknown" && isCheckFailingSeverity(severity),
    held,
    observedThisRun,
  };
}

function runRows(
  inventory: FindingInventory,
  ledger: Extract<FindingRunOutcomes, { kind: "reviewed" }>["ledger"],
): FindingViewRow[] {
  const rows = new Map<FindingId, FindingViewRow>();
  for (const accepted of ledger.accepted) {
    if (rows.has(accepted.findingId)) continue;
    rows.set(
      accepted.findingId,
      viewRow(
        accepted.findingId,
        accepted.kind === "summary_only" ? "summary_only" : "new",
        accepted.placement.finding.severity,
        null,
        true,
      ),
    );
  }
  for (const entry of ledger.reaffirmed) {
    const held = inventory.findings.get(entry.id);
    if (rows.has(entry.id) || held == null || held.state !== "open") continue;
    rows.set(
      entry.id,
      viewRow(
        entry.id,
        held.source === "thread" ? "confirmed_at_head" : "summary_only",
        higherSeverity(held.severity, entry.severity),
        held,
        true,
      ),
    );
  }
  return [...rows.values()];
}

function carriedStatus(finding: InventoryFinding): FindingStatus {
  if (finding.source === "summary") return "summary_only";
  return finding.positionStale ? "outdated_location" : "open_unverified";
}

function compareCarried(left: InventoryFinding, right: InventoryFinding): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.path.localeCompare(right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

export function buildFindingView(
  inventory: FindingInventory,
  outcomes: FindingRunOutcomes,
): FindingView {
  const duplicates = outcomes.kind === "reviewed" ? outcomes.duplicates : [];
  const cleanedIds = new Set(
    duplicates
      .filter((duplicate) => inventory.findings.get(duplicate.id)?.url !== duplicate.canonicalUrl)
      .map((duplicate) => duplicate.id),
  );
  const observed = (outcomes.kind === "reviewed" ? runRows(inventory, outcomes.ledger) : []).filter(
    (row) => !cleanedIds.has(row.id),
  );
  const observedIds = new Set(observed.map((row) => row.id));
  const carried = [...inventory.findings.values()]
    .filter(
      (finding) =>
        finding.state === "open" &&
        finding.aliasOf == null &&
        !observedIds.has(finding.id) &&
        !cleanedIds.has(finding.id) &&
        (finding.source === "thread" || outcomes.kind === "not_reviewed"),
    )
    .toSorted(compareCarried)
    .map((finding) =>
      viewRow(finding.id, carriedStatus(finding), finding.severity, finding, false),
    );
  const rows = [...observed, ...carried];
  return {
    completeness: inventory.completeness,
    rows,
    blockingCount: rows.filter((row) => row.blocking).length,
    suppressedDismissedCount:
      outcomes.kind === "reviewed" ? outcomes.ledger.suppressedDismissedCount : 0,
    duplicates,
  };
}

export function checkConclusion(view: FindingView): FindingCheckConclusion {
  if (view.blockingCount > 0) return "failure";
  return view.completeness === "complete" ? "success" : "neutral";
}

export function findingCheck(view: FindingView): FindingCheck {
  return { conclusion: checkConclusion(view), blockingCount: view.blockingCount };
}

function statusLabel(status: FindingStatus): string {
  switch (status) {
    case "new":
      return "New";
    case "confirmed_at_head":
      return "Confirmed at head";
    case "open_unverified":
      return "Open, not rechecked";
    case "outdated_location":
      return "Outdated location";
    case "summary_only":
      return "Summary only";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function locationLabel(finding: InventoryFinding): string {
  if (finding.line == null) return "line unknown";
  if (finding.startLine == null || finding.startLine === finding.line)
    return `line ${finding.line}`;
  return `lines ${finding.startLine}-${finding.line}`;
}

function shortTitle(title: string): string {
  return title.length <= CARRIED_TITLE_MAX_CHARS
    ? title
    : `${title.slice(0, CARRIED_TITLE_MAX_CHARS - 1)}…`;
}

export function findingSeverityLabel(severity: FindingSeverity | "unknown"): string {
  return severity === "unknown" ? "Unrated" : severity;
}

export function renderCarriedFindingCell(row: FindingViewRow, finding: InventoryFinding): string {
  const label = finding.fileDeleted
    ? `${statusLabel(row.status)}, file deleted`
    : statusLabel(row.status);
  const marker =
    finding.source === "summary" && finding.lens !== "unknown" && finding.severity !== "unknown"
      ? renderFindingRowMarker({
          id: finding.id,
          lens: finding.lens,
          severity: finding.severity,
          path: finding.path,
          line: finding.line,
          title: finding.title,
          ...(finding.reopens != null ? { reopens: finding.reopens } : {}),
        })
      : "";
  return `${renderTableLink(shortTitle(finding.title), finding.url)}<br>${renderTableLocationMeta(label, finding.path, locationLabel(finding))}${marker}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function threadLinks(duplicates: readonly CleanedDuplicate[]): string {
  return [...new Set(duplicates.map((duplicate) => duplicate.canonicalUrl))]
    .map((url) => `[thread](${url})`)
    .join(", ");
}

export function renderResolvedThisRun(view: FindingView): string {
  const resolved = view.duplicates.filter((duplicate) => duplicate.resolved);
  const linked = view.duplicates.filter((duplicate) => !duplicate.resolved);
  const parts: string[] = [];
  if (resolved.length > 0) {
    parts.push(
      `Resolved this run: ${plural(resolved.length, "duplicate")} (tracked in ${threadLinks(resolved)}).`,
    );
  }
  if (linked.length > 0) {
    parts.push(
      `Linked ${plural(linked.length, "discussed duplicate")} to ${threadLinks(linked)} and left ${linked.length === 1 ? "it" : "them"} open.`,
    );
  }
  if (view.suppressedDismissedCount > 0) {
    parts.push(
      `${plural(view.suppressedDismissedCount, "observation")} matched dismissed findings.`,
    );
  }
  return parts.join(" ");
}

function findingsHeading(view: FindingView): string {
  return `${renderTableStrong("Findings")} · ${view.rows.length} open · ${view.blockingCount} blocking`;
}

type ListedRow = readonly [FindingViewRow, InventoryFinding];

function sectionBody(view: FindingView, rows: readonly ListedRow[], omitted: number): string {
  const parts = [findingsHeading(view), ""];
  if (rows.length > 0) {
    parts.push(
      renderKeyValueTable(
        rows.map(([row, finding]) => [
          renderTableStrong(findingSeverityLabel(row.severity)),
          renderCarriedFindingCell(row, finding),
        ]),
      ),
    );
  }
  if (omitted > 0) {
    parts.push("", escapeTableHtml(`${omitted} more open findings are listed on their threads.`));
  }
  if (view.completeness !== "complete") parts.push("", FINDING_INVENTORY_UNAVAILABLE_NOTE);
  return parts.join("\n").trimEnd();
}

export function renderFindingsSection(view: FindingView, budgetChars: number): string {
  if (view.rows.length === 0) {
    return view.completeness === "complete" ? "" : FINDING_INVENTORY_UNAVAILABLE_NOTE;
  }
  const listed = view.rows.flatMap((row): ListedRow[] =>
    row.held == null || row.observedThisRun ? [] : [[row, row.held]],
  );
  const withDroppable = (keep: number): string => {
    let left = keep;
    const rows = listed.filter(([, finding]) => {
      if (finding.source === "summary") return true;
      left -= 1;
      return left >= 0;
    });
    return sectionBody(view, rows, listed.length - rows.length);
  };
  const droppableCount = listed.filter(([, finding]) => finding.source !== "summary").length;
  const full = withDroppable(droppableCount);
  if (full.length <= budgetChars) return full;
  let best = withDroppable(0);
  let lo = 1;
  let hi = droppableCount - 1;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const body = withDroppable(keep);
    if (body.length <= budgetChars) {
      best = body;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}
