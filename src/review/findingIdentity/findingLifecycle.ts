import {
  escapeTableHtml,
  renderKeyValueTable,
  renderTableLink,
  renderTableLocationMeta,
  renderTableStrong,
} from "../../github/markdownFormat.ts";
import type { FindingLedger, ReaffirmedFinding } from "../orchestrator/orchestratorTypes.ts";
import {
  cappedFindingSeverity,
  isCheckFailingSeverity,
  type CoverageGapCeiling,
  type ReviewFinding,
} from "../reviewSchema.ts";
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
  readonly threadId?: string;
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

function severityRank(severity: FindingSeverity | "unknown") {
  return ((pinnedReturn: number) => pinnedReturn)(SEVERITY_ORDER.indexOf(severity));
}

export function higherSeverity(
  left: FindingSeverity | "unknown",
  right: FindingSeverity | "unknown",
) {
  return ((pinnedReturn: FindingSeverity | "unknown") => pinnedReturn)(
    severityRank(left) <= severityRank(right) ? left : right,
  );
}

export function severityWithinRunCap(
  severity: ReviewFinding["severity"],
  params: {
    readonly testsLens: boolean;
    readonly anchorPath: string;
    readonly heldPath?: string;
    readonly judged: boolean;
    readonly coverageGapCeiling?: CoverageGapCeiling;
  },
) {
  const capped = cappedFindingSeverity({
    severity,
    testsLens: params.testsLens,
    anchorPath: params.anchorPath,
    judged: params.judged,
    coverageGapCeiling: params.coverageGapCeiling,
  });
  if (params.heldPath == null || params.heldPath === params.anchorPath)
    return ((pinnedReturn: ReviewFinding["severity"]) => pinnedReturn)(capped);
  return ((pinnedReturn: ReviewFinding["severity"]) => pinnedReturn)(
    cappedFindingSeverity({
      severity: capped,
      testsLens: params.testsLens,
      anchorPath: params.heldPath,
      judged: params.judged,
      coverageGapCeiling: params.coverageGapCeiling,
    }),
  );
}

export function cappedReaffirmedSeverity(params: {
  readonly held: FindingSeverity | "unknown" | undefined;
  readonly observed: ReviewFinding["severity"];
  readonly testsLens: boolean;
  readonly anchorPath: string;
  readonly heldPath?: string;
  readonly judged: boolean;
  readonly coverageGapCeiling?: CoverageGapCeiling;
}) {
  const merged =
    params.held == null ? params.observed : higherSeverity(params.held, params.observed);
  const severity = merged === "unknown" ? params.observed : merged;
  return ((pinnedReturn: ReviewFinding["severity"]) => pinnedReturn)(
    severityWithinRunCap(severity, params),
  );
}

function viewRow(
  id: FindingId,
  status: FindingStatus,
  severity: FindingSeverity | "unknown",
  held: InventoryFinding | null,
  observedThisRun: boolean,
  checkFailSeverity: ReviewFinding["severity"],
) {
  return ((pinnedReturn: FindingViewRow) => pinnedReturn)({
    id,
    status,
    severity,
    blocking: severity !== "unknown" && isCheckFailingSeverity(severity, checkFailSeverity),
    held,
    observedThisRun,
  });
}

function runRows(
  inventory: FindingInventory,
  ledger: Extract<FindingRunOutcomes, { kind: "reviewed" }>["ledger"],
  checkFailSeverity: ReviewFinding["severity"],
) {
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
  return ((pinnedReturn: FindingViewRow[]) => pinnedReturn)([...rows.values()]);
}

function carriedStatus(finding: InventoryFinding) {
  if (finding.source === "summary")
    return ((pinnedReturn: FindingStatus) => pinnedReturn)("summary_only");
  return ((pinnedReturn: FindingStatus) => pinnedReturn)(
    finding.positionStale ? "outdated_location" : "open_unverified",
  );
}

function compareCarried(left: InventoryFinding, right: InventoryFinding) {
  return ((pinnedReturn: number) => pinnedReturn)(
    severityRank(left.severity) - severityRank(right.severity) ||
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

function canonicalAfterCleanup(
  inventory: FindingInventory,
  cleanedTo: ReadonlyMap<FindingId, FindingId>,
  start: FindingId,
) {
  const seen = new Set<FindingId>();
  let current = start;
  while (!seen.has(current)) {
    seen.add(current);
    const next = cleanedTo.get(current) ?? inventory.findings.get(current)?.aliasOf;
    if (next == null) return ((pinnedReturn: FindingId | null) => pinnedReturn)(current);
    current = next;
  }
  return ((pinnedReturn: FindingId | null) => pinnedReturn)(null);
}

function openCopySeverities(inventory: FindingInventory, cleaned: readonly CleanedDuplicate[]) {
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
  return ((pinnedReturn: Map<FindingId, FindingSeverity | "unknown">) => pinnedReturn)(severities);
}

function unresolvedSameIdCopies(
  inventory: FindingInventory,
  duplicates: readonly CleanedDuplicate[],
) {
  const resolvedThreads = new Set(
    duplicates.flatMap((duplicate) =>
      duplicate.resolved && duplicate.threadId != null ? [duplicate.threadId] : [],
    ),
  );
  const severities = new Map<FindingId, FindingSeverity | "unknown">();
  const exemplars = new Map<FindingId, InventoryFinding>();
  for (const copy of inventory.sameIdCopies) {
    if (copy.state !== "open" || copy.source !== "thread" || copy.severity === "unknown") continue;
    if (copy.threadId != null && resolvedThreads.has(copy.threadId)) continue;
    const severity = higherSeverity(severities.get(copy.id) ?? "unknown", copy.severity);
    severities.set(copy.id, severity);
    const current = exemplars.get(copy.id);
    if (current == null || higherSeverity(current.severity, copy.severity) === copy.severity)
      exemplars.set(copy.id, copy);
  }
  return { severities, exemplars };
}

export function buildFindingView(
  inventory: FindingInventory,
  outcomes: FindingRunOutcomes,
  checkFailSeverity: ReviewFinding["severity"],
) {
  const duplicates = outcomes.kind === "reviewed" ? outcomes.duplicates : [];
  const cleaned = duplicates.filter(
    (duplicate) => inventory.findings.get(duplicate.id)?.url !== duplicate.canonicalUrl,
  );
  const cleanedIds = new Set(cleaned.map((duplicate) => duplicate.id));
  const copySeverities = openCopySeverities(inventory, cleaned);
  const sameIdCopies = unresolvedSameIdCopies(inventory, duplicates);
  for (const [id, severity] of sameIdCopies.severities) {
    const current = copySeverities.get(id);
    copySeverities.set(id, current == null ? severity : higherSeverity(current, severity));
  }
  const reaffirmedById = new Map<FindingId, ReaffirmedFinding>();
  const acceptedIds = new Set<FindingId>();
  if (outcomes.kind === "reviewed") {
    for (const entry of outcomes.ledger.reaffirmed) reaffirmedById.set(entry.id, entry);
    for (const entry of outcomes.ledger.accepted) acceptedIds.add(entry.findingId);
  }
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
  const presentIds = new Set([...observed, ...carried].map((row) => row.id));
  const carriedCopies = [...sameIdCopies.exemplars.values()]
    .filter((copy) => {
      const severity = sameIdCopies.severities.get(copy.id) ?? copy.severity;
      return (
        !presentIds.has(copy.id) &&
        severity !== "unknown" &&
        isCheckFailingSeverity(severity, checkFailSeverity)
      );
    })
    .toSorted(compareCarried)
    .map((copy) =>
      viewRow(
        copy.id,
        carriedStatus(copy),
        sameIdCopies.severities.get(copy.id) ?? copy.severity,
        copy,
        false,
        checkFailSeverity,
      ),
    );
  const rows = [...observed, ...carried, ...carriedCopies].map((row) => {
    const copySeverity = copySeverities.get(row.id);
    const merged = copySeverity == null ? row.severity : higherSeverity(row.severity, copySeverity);
    const entry = acceptedIds.has(row.id) ? undefined : reaffirmedById.get(row.id);
    const severity =
      entry == null || merged === "unknown"
        ? merged
        : severityWithinRunCap(merged, {
            testsLens: entry.source === "tests",
            anchorPath: entry.placement.finding.file,
            ...(row.held == null ? {} : { heldPath: row.held.path }),
            judged: entry.judged !== false,
            ...(entry.coverageGapCeiling == null
              ? {}
              : { coverageGapCeiling: entry.coverageGapCeiling }),
          });
    return severity === row.severity
      ? row
      : viewRow(row.id, row.status, severity, row.held, row.observedThisRun, checkFailSeverity);
  });
  return ((pinnedReturn: FindingView) => pinnedReturn)({
    completeness: inventory.completeness,
    rows,
    blockingCount: rows.filter((row) => row.blocking).length,
    suppressedDismissedCount:
      outcomes.kind === "reviewed" ? outcomes.ledger.suppressedDismissedCount : 0,
    duplicates,
  });
}

export function checkConclusion(view: FindingView) {
  if (view.blockingCount > 0)
    return ((pinnedReturn: FindingCheckConclusion) => pinnedReturn)("failure");
  return ((pinnedReturn: FindingCheckConclusion) => pinnedReturn)(
    view.completeness === "complete" ? "success" : "neutral",
  );
}

export function findingCheck(view: FindingView) {
  return ((pinnedReturn: FindingCheck) => pinnedReturn)({
    conclusion: checkConclusion(view),
    blockingCount: view.blockingCount,
  });
}

function statusLabel(status: FindingStatus) {
  switch (status) {
    case "new":
      return ((pinnedReturn: string) => pinnedReturn)("New");
    case "confirmed_at_head":
      return ((pinnedReturn: string) => pinnedReturn)("Confirmed at head");
    case "open_unverified":
      return ((pinnedReturn: string) => pinnedReturn)("Open, not rechecked");
    case "outdated_location":
      return ((pinnedReturn: string) => pinnedReturn)("Outdated location");
    case "summary_only":
      return ((pinnedReturn: string) => pinnedReturn)("Summary only");
    default: {
      const exhaustive: never = status;
      return ((pinnedReturn: string) => pinnedReturn)(exhaustive);
    }
  }
}

function locationLabel(finding: InventoryFinding) {
  if (finding.line == null) return ((pinnedReturn: string) => pinnedReturn)("line unknown");
  if (finding.startLine == null || finding.startLine === finding.line)
    return ((pinnedReturn: string) => pinnedReturn)(`line ${finding.line}`);
  return ((pinnedReturn: string) => pinnedReturn)(`lines ${finding.startLine}-${finding.line}`);
}

export function truncateWithEllipsis(title: string, maxChars: number) {
  return ((pinnedReturn: string) => pinnedReturn)(
    title.length <= maxChars ? title : `${title.slice(0, maxChars - 1)}…`,
  );
}

function shortTitle(title: string) {
  return truncateWithEllipsis(title, CARRIED_TITLE_MAX_CHARS);
}

export function findingSeverityLabel(severity: FindingSeverity | "unknown") {
  return ((pinnedReturn: string) => pinnedReturn)(severity === "unknown" ? "Unrated" : severity);
}

export function renderCarriedFindingCell(row: FindingViewRow, finding: InventoryFinding) {
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
  return ((pinnedReturn: string) => pinnedReturn)(
    `${renderTableLink(shortTitle(finding.title), finding.url)}<br>${renderTableLocationMeta(label, finding.path, locationLabel(finding))}${marker}`,
  );
}

function plural(count: number, noun: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`${count} ${noun}${count === 1 ? "" : "s"}`);
}

function threadLinks(duplicates: readonly CleanedDuplicate[]) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [...new Set(duplicates.map((duplicate) => duplicate.canonicalUrl))]
      .map((url) => `[thread](${url})`)
      .join(", "),
  );
}

export function renderResolvedThisRun(view: FindingView) {
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
  return ((pinnedReturn: string) => pinnedReturn)(parts.join(" "));
}

function findingsHeading(view: FindingView) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `${renderTableStrong("Findings")} · ${view.rows.length} open · ${view.blockingCount} blocking`,
  );
}

type ListedRow = readonly [FindingViewRow, InventoryFinding];

function sectionBody(view: FindingView, rows: readonly ListedRow[], omitted: number) {
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
  return ((pinnedReturn: string) => pinnedReturn)(parts.join("\n").trimEnd());
}

export function renderFindingsSection(view: FindingView, budgetChars: number) {
  const budget = Math.max(0, budgetChars);
  if (view.rows.length === 0) {
    const note = view.completeness === "complete" ? "" : FINDING_INVENTORY_UNAVAILABLE_NOTE;
    return ((pinnedReturn: string) => pinnedReturn)(note.length <= budget ? note : "");
  }
  const listed = view.rows.flatMap((row) =>
    ((pinnedReturn: ListedRow[]) => pinnedReturn)(
      row.held == null || row.observedThisRun ? [] : [[row, row.held]],
    ),
  );
  const withLimits = (droppableLimit: number, durableLimit: number) => {
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
    return ((pinnedReturn: string) => pinnedReturn)(
      sectionBody(view, rows, listed.length - rows.length),
    );
  };
  const durableCount = listed.filter(([, finding]) => finding.source === "summary").length;
  const droppableCount = listed.length - durableCount;
  return ((pinnedReturn: string) => pinnedReturn)(
    largestFittingBody(droppableCount, budget, (limit) => withLimits(limit, durableCount)) ??
      largestFittingBody(durableCount - 1, budget, (limit) => withLimits(0, limit)) ??
      "",
  );
}

export function largestFittingBody(
  maxLimit: number,
  maxBodyChars: number,
  render: (limit: number) => string,
) {
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
  return ((pinnedReturn: string | null) => pinnedReturn)(best);
}
