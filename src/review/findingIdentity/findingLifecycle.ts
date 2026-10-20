import {
  escapeTableHtml,
  renderKeyValueTable,
  renderTableLink,
  renderTableLocationMeta,
  renderTableStrong,
} from "../../github/markdownFormat.ts";
import type { FindingLedger } from "../orchestrator/orchestratorTypes.ts";
import { isCheckFailingSeverity, type ReviewFinding } from "../reviewSchema.ts";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../statusCopy.ts";
import type {
  FindingInventory,
  InventoryCompleteness,
  InventoryFinding,
} from "./findingInventory.ts";
import { renderFindingRowMarker, type FindingId, type FindingSeverity } from "./findingMarker.ts";

export type FindingStatus =
  | "new"
  | "confirmed_at_head"
  | "open_unverified"
  | "outdated_location"
  | "summary_only";

export type CleanedDuplicate = {
  readonly id: FindingId;
  readonly canonicalId: FindingId;
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

export function higherSeverity(
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
  checkFailSeverity: ReviewFinding["severity"],
): FindingViewRow {
  return {
    id,
    status,
    severity,
    blocking: severity !== "unknown" && isCheckFailingSeverity(severity, checkFailSeverity),
    held,
    observedThisRun,
  };
}

function runRows(
  inventory: FindingInventory,
  ledger: Extract<FindingRunOutcomes, { kind: "reviewed" }>["ledger"],
  checkFailSeverity: ReviewFinding["severity"],
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
        checkFailSeverity,
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
        checkFailSeverity,
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

function canonicalAfterCleanup(
  inventory: FindingInventory,
  cleanedTo: ReadonlyMap<FindingId, FindingId>,
  start: FindingId,
): FindingId | null {
  const seen = new Set<FindingId>();
  let current = start;
  while (!seen.has(current)) {
    seen.add(current);
    const next = cleanedTo.get(current) ?? inventory.findings.get(current)?.aliasOf;
    if (next == null) return current;
    current = next;
  }
  return null;
}

function openCopySeverities(
  inventory: FindingInventory,
  cleaned: readonly CleanedDuplicate[],
): Map<FindingId, FindingSeverity | "unknown"> {
  const cleanedTo = new Map(cleaned.map((duplicate) => [duplicate.id, duplicate.canonicalId]));
  const closedIds = new Set(
    cleaned.filter((duplicate) => duplicate.resolved).map((duplicate) => duplicate.id),
  );
  const severities = new Map<FindingId, FindingSeverity | "unknown">();
  for (const finding of inventory.findings.values()) {
    if (finding.state !== "open" || closedIds.has(finding.id)) continue;
    if (finding.aliasOf == null && !cleanedTo.has(finding.id)) continue;
    const canonicalId = canonicalAfterCleanup(inventory, cleanedTo, finding.id);
    if (canonicalId == null) continue;
    severities.set(
      canonicalId,
      higherSeverity(severities.get(canonicalId) ?? "unknown", finding.severity),
    );
  }
  return severities;
}

export function buildFindingView(
  inventory: FindingInventory,
  outcomes: FindingRunOutcomes,
  checkFailSeverity: ReviewFinding["severity"],
): FindingView {
  const duplicates = outcomes.kind === "reviewed" ? outcomes.duplicates : [];
  const cleaned = duplicates.filter(
    (duplicate) => inventory.findings.get(duplicate.id)?.url !== duplicate.canonicalUrl,
  );
  const cleanedIds = new Set(cleaned.map((duplicate) => duplicate.id));
  const copySeverities = openCopySeverities(inventory, cleaned);
  const observed = (
    outcomes.kind === "reviewed" ? runRows(inventory, outcomes.ledger, checkFailSeverity) : []
  ).filter((row) => !cleanedIds.has(row.id));
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
      viewRow(
        finding.id,
        carriedStatus(finding),
        finding.severity,
        finding,
        false,
        checkFailSeverity,
      ),
    );
  const rows = [...observed, ...carried].map((row) => {
    const copySeverity = copySeverities.get(row.id);
    return copySeverity == null
      ? row
      : viewRow(
          row.id,
          row.status,
          higherSeverity(row.severity, copySeverity),
          row.held,
          row.observedThisRun,
          checkFailSeverity,
        );
  });
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
  const budget = Math.max(0, budgetChars);
  if (view.rows.length === 0) {
    const note = view.completeness === "complete" ? "" : FINDING_INVENTORY_UNAVAILABLE_NOTE;
    return note.length <= budget ? note : "";
  }
  const listed = view.rows.flatMap((row): ListedRow[] =>
    row.held == null || row.observedThisRun ? [] : [[row, row.held]],
  );
  const withLimits = (droppableLimit: number, durableLimit: number): string => {
    let droppableLeft = droppableLimit;
    let durableLeft = durableLimit;
    const rows = listed.filter(([, finding]) => {
      if (finding.source === "summary") {
        durableLeft -= 1;
        return durableLeft >= 0;
      }
      droppableLeft -= 1;
      return droppableLeft >= 0;
    });
    return sectionBody(view, rows, listed.length - rows.length);
  };
  const durableCount = listed.filter(([, finding]) => finding.source === "summary").length;
  const droppableCount = listed.length - durableCount;
  return (
    largestFittingBody(droppableCount, budget, (limit) => withLimits(limit, durableCount)) ??
    largestFittingBody(durableCount - 1, budget, (limit) => withLimits(0, limit)) ??
    ""
  );
}

export function largestFittingBody(
  maxLimit: number,
  maxBodyChars: number,
  render: (limit: number) => string,
): string | null {
  let lo = 0;
  let hi = maxLimit;
  let best: string | null = null;
  while (lo <= hi) {
    const limit = Math.floor((lo + hi) / 2);
    const body = render(limit);
    if (body.length <= maxBodyChars) {
      best = body;
      lo = limit + 1;
    } else {
      hi = limit - 1;
    }
  }
  return best;
}
