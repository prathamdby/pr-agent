import type { FindingInventory, InventoryFinding } from "./findingInventory.js";
import { neutralizeMarkerEcho, type FindingId, type FindingSeverity } from "./findingMarker.js";

export const OVERLAP_WINDOW_LINES = 10;
export const MAX_OVERLAP_ROUNDS = 1;
const NEAREST_SAME_FILE_CANDIDATES = 4;

export type ObservationRelation =
  | { readonly kind: "new" }
  | { readonly kind: "continues"; readonly findingId: FindingId }
  | {
      readonly kind: "distinct_from";
      readonly findingIds: readonly FindingId[];
      readonly reason: string;
    }
  | { readonly kind: "uncertain"; readonly findingIds: readonly FindingId[] };

export type ReconcileObservation = {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly severity: FindingSeverity;
  readonly title: string;
};

export type AcceptedThisRun = {
  readonly id: FindingId;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly detail?: string;
  readonly url: string;
};

export type OverlapCandidate = {
  readonly findingId: FindingId;
  readonly path: string;
  readonly line: number | null;
  readonly title: string;
  readonly detail?: string;
  readonly state: "open" | "resolved" | "accepted_this_run";
  readonly url: string;
};

export type OverlapQuestion = { readonly candidates: readonly OverlapCandidate[] };

export type ReconcileOutcome =
  | {
      readonly kind: "post_thread";
      readonly id: FindingId;
      readonly reopens?: FindingId;
      readonly relatedLinks: readonly string[];
    }
  | { readonly kind: "reaffirm"; readonly id: FindingId; readonly severity: FindingSeverity }
  | { readonly kind: "promote"; readonly id: FindingId }
  | { readonly kind: "suppressed_dismissed"; readonly id: FindingId }
  | {
      readonly kind: "summary_only";
      readonly id: FindingId;
      readonly reason: "inventory_incomplete" | "unanswered_overlap";
    };

export type ReconcileStep =
  | { readonly outcome: ReconcileOutcome }
  | { readonly question: OverlapQuestion }
  | { readonly rejected: string };

type Positioned = Pick<
  InventoryFinding,
  "path" | "previousPath" | "startLine" | "line" | "positionStale"
>;

type Span = Pick<ReconcileObservation, "file" | "startLine" | "endLine">;

function rangesNear(observation: Span, start: number, end: number): boolean {
  return (
    observation.startLine <= end + OVERLAP_WINDOW_LINES &&
    start <= observation.endLine + OVERLAP_WINDOW_LINES
  );
}

function rangeGap(observation: Span, start: number, end: number): number {
  if (observation.endLine < start) return start - observation.endLine;
  if (end < observation.startLine) return observation.startLine - end;
  return 0;
}

export function overlaps(observation: Span, finding: Positioned): boolean {
  if (finding.path !== observation.file && finding.previousPath !== observation.file) return false;
  if (finding.positionStale || finding.line == null) return true;
  const start = Math.min(finding.startLine ?? finding.line, finding.line);
  return rangesNear(observation, start, Math.max(finding.startLine ?? finding.line, finding.line));
}

function inventoryCandidate(finding: InventoryFinding): OverlapCandidate {
  return {
    findingId: finding.id,
    path: finding.path,
    line: finding.line,
    title: neutralizeMarkerEcho(finding.title),
    ...(finding.detail != null ? { detail: finding.detail } : {}),
    state: finding.state,
    url: finding.url,
  };
}

function acceptedCandidate(accepted: AcceptedThisRun): OverlapCandidate {
  return {
    findingId: accepted.id,
    path: accepted.path,
    line: accepted.startLine,
    title: neutralizeMarkerEcho(accepted.title),
    ...(accepted.detail != null ? { detail: accepted.detail } : {}),
    state: "accepted_this_run",
    url: accepted.url,
  };
}

function retrievalCandidates(
  observation: Span,
  inventory: FindingInventory,
  acceptedThisRun: readonly AcceptedThisRun[],
): OverlapCandidate[] {
  const overlapped = [...inventory.findings.values()]
    .filter((finding) => overlaps(observation, finding))
    .map(inventoryCandidate);
  const known = new Set(overlapped.map((candidate) => candidate.findingId));
  const ranked: { candidate: OverlapCandidate; gap: number; line: number }[] = [];
  for (const finding of inventory.findings.values()) {
    if (known.has(finding.id) || finding.state !== "open") continue;
    if (finding.path !== observation.file && finding.previousPath !== observation.file) continue;
    if (finding.positionStale || finding.line == null) continue;
    const start = Math.min(finding.startLine ?? finding.line, finding.line);
    const end = Math.max(finding.startLine ?? finding.line, finding.line);
    ranked.push({
      candidate: inventoryCandidate(finding),
      gap: rangeGap(observation, start, end),
      line: start,
    });
  }
  for (const accepted of acceptedThisRun) {
    if (known.has(accepted.id) || accepted.path !== observation.file) continue;
    ranked.push({
      candidate: acceptedCandidate(accepted),
      gap: rangeGap(observation, accepted.startLine, accepted.endLine),
      line: accepted.startLine,
    });
  }
  ranked.sort(
    (left, right) =>
      left.gap - right.gap ||
      left.line - right.line ||
      left.candidate.findingId.localeCompare(right.candidate.findingId),
  );
  return [
    ...overlapped,
    ...ranked.slice(0, NEAREST_SAME_FILE_CANDIDATES).map((row) => row.candidate),
  ];
}

function answeredIds(relation: ObservationRelation): ReadonlySet<FindingId> {
  switch (relation.kind) {
    case "new":
      return new Set();
    case "continues":
      return new Set([relation.findingId]);
    case "distinct_from":
    case "uncertain":
      return new Set(relation.findingIds);
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

function continueFinding(params: {
  readonly target: FindingId;
  readonly observation: ReconcileObservation;
  readonly inventory: FindingInventory;
  readonly acceptedThisRun: readonly AcceptedThisRun[];
  readonly retrieved: ReadonlySet<FindingId>;
  readonly complete: boolean;
  readonly mint: () => FindingId;
}): ReconcileStep {
  const { target, observation, inventory } = params;
  const accepted = params.acceptedThisRun.find((entry) => entry.id === target);
  const finding = inventory.findings.get(target);
  if (finding == null && accepted == null) return { rejected: `Unknown finding id ${target}.` };
  if (!params.retrieved.has(target)) {
    return { rejected: `Finding ${target} does not overlap this observation.` };
  }
  if (finding == null) {
    return { outcome: { kind: "reaffirm", id: target, severity: observation.severity } };
  }
  const canonicalId = inventory.canonicalOf(target);
  const canonical = canonicalId == null ? undefined : inventory.findings.get(canonicalId);
  if (canonical == null) return { rejected: `Finding ${target} has no canonical finding.` };
  if (canonical.state === "open") {
    if (canonical.source === "summary" && params.complete) {
      return { outcome: { kind: "promote", id: canonical.id } };
    }
    return { outcome: { kind: "reaffirm", id: canonical.id, severity: observation.severity } };
  }
  if (canonical.resolution === "fixed") {
    const id = params.mint();
    if (!params.complete) {
      return { outcome: { kind: "summary_only", id, reason: "inventory_incomplete" } };
    }
    return { outcome: { kind: "post_thread", id, reopens: canonical.id, relatedLinks: [] } };
  }
  return { outcome: { kind: "suppressed_dismissed", id: canonical.id } };
}

export function reconcileObservation(params: {
  readonly observation: ReconcileObservation;
  readonly relation: ObservationRelation;
  readonly inventory: FindingInventory;
  readonly acceptedThisRun: readonly AcceptedThisRun[];
  readonly overlapRoundsLeft: number;
  readonly mint: () => FindingId;
}): ReconcileStep {
  const { observation, relation, inventory, acceptedThisRun } = params;
  const complete = inventory.completeness === "complete";
  const candidates = retrievalCandidates(observation, inventory, acceptedThisRun);
  if (relation.kind === "continues") {
    return continueFinding({
      target: relation.findingId,
      observation,
      inventory,
      acceptedThisRun,
      retrieved: new Set(candidates.map((candidate) => candidate.findingId)),
      complete,
      mint: params.mint,
    });
  }
  const known = new Set([
    ...inventory.findings.keys(),
    ...acceptedThisRun.map((accepted) => accepted.id),
  ]);
  const answered = answeredIds(relation);
  const unknown = [...answered].filter((findingId) => !known.has(findingId));
  if (unknown.length > 0) return { rejected: `Unknown finding ids ${unknown.join(", ")}.` };
  const id = params.mint();
  if (!complete) return { outcome: { kind: "summary_only", id, reason: "inventory_incomplete" } };
  const unanswered = candidates.filter((candidate) => !answered.has(candidate.findingId));
  if (unanswered.length > 0) {
    if (params.overlapRoundsLeft > 0) return { question: { candidates: unanswered } };
    return { outcome: { kind: "summary_only", id, reason: "unanswered_overlap" } };
  }
  const relatedLinks =
    relation.kind === "uncertain"
      ? candidates
          .filter((candidate) => answered.has(candidate.findingId) && candidate.url.length > 0)
          .map((candidate) => candidate.url)
      : [];
  return { outcome: { kind: "post_thread", id, relatedLinks } };
}
