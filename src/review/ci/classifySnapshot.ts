import { OWN_COMMIT_STATUS_CONTEXT } from "../../settings/reviewConstants.js";
import type { CiCheckRunSnapshot, CiLegacyStatus } from "./ciSummaryTypes.js";

export type CiFactSource = "check_run" | "status";

/** Derived rollup stored on `pr_head_ci_state`. */
export type CiRollup = "pending" | "passing" | "failing" | "none" | "unknown";

export type CiCheckFact = {
  readonly name: string;
  readonly source: CiFactSource;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string | null;
  readonly external_id: string | null;
  readonly app_id: number | null;
  readonly check_run_id: number | null;
  readonly observed_at: string;
};

/** Identity for the installation's own check. Name prefixes are not identity. */
export type OwnCheckIdentity = {
  readonly githubAppId: string;
  readonly workItemId?: string;
};

export function isOwnCiCheck(
  identity: OwnCheckIdentity,
  fact: Pick<CiCheckFact, "app_id" | "external_id">,
): boolean {
  if (fact.app_id != null && String(fact.app_id) === identity.githubAppId) return true;
  return identity.workItemId != null && fact.external_id === identity.workItemId;
}

export const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);

export const PENDING_CHECK_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

export const FAILING_LEGACY_STATES = new Set(["failure", "error"]);
export const PENDING_LEGACY_STATES = new Set(["pending"]);

const SNAPSHOT_OBSERVED_AT = "1970-01-01T00:00:00.000Z";

export function isCheckFactFailing(fact: CiCheckFact): boolean {
  if (fact.source === "status") return FAILING_LEGACY_STATES.has(fact.status);
  return (
    fact.status === "completed" &&
    fact.conclusion != null &&
    FAILING_CHECK_CONCLUSIONS.has(fact.conclusion)
  );
}

export function isCheckFactPending(fact: CiCheckFact): boolean {
  if (fact.source === "status") return PENDING_LEGACY_STATES.has(fact.status);
  return (
    fact.status !== "completed" &&
    (PENDING_CHECK_STATUSES.has(fact.status) || fact.conclusion == null)
  );
}

export function classifySnapshot(facts: readonly CiCheckFact[]): CiRollup {
  if (facts.length === 0) return "none";
  if (facts.some(isCheckFactFailing)) return "failing";
  if (facts.some(isCheckFactPending)) return "pending";
  return "passing";
}

export function checkRunSnapshotToFact(
  run: CiCheckRunSnapshot,
  observedAt: string = SNAPSHOT_OBSERVED_AT,
): CiCheckFact {
  return {
    name: run.name,
    source: "check_run",
    status: run.status,
    conclusion: run.conclusion,
    url: run.htmlUrl,
    external_id: run.externalId ?? null,
    app_id: run.appId ?? null,
    check_run_id: run.id,
    observed_at: observedAt,
  };
}

export function legacyStatusToFact(
  status: CiLegacyStatus,
  observedAt: string = SNAPSHOT_OBSERVED_AT,
): CiCheckFact {
  return {
    name: status.context,
    source: "status",
    status: status.state,
    conclusion: null,
    url: status.targetUrl,
    external_id: null,
    app_id: null,
    check_run_id: null,
    observed_at: observedAt,
  };
}

export function classifyGithubSnapshot(
  checks: readonly CiCheckRunSnapshot[],
  statuses: readonly CiLegacyStatus[],
): CiRollup {
  return classifySnapshot([
    ...checks.map((run) => checkRunSnapshotToFact(run)),
    ...statuses.map((status) => legacyStatusToFact(status)),
  ]);
}

export function observedAtFromGithub(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    if (value != null && value.length > 0 && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return new Date().toISOString();
}

export function applyCiCheckFact(
  current: Readonly<Record<string, CiCheckFact>>,
  incoming: CiCheckFact,
  maxChecks: number,
): {
  readonly checks: Record<string, CiCheckFact>;
  readonly accepted: boolean;
  readonly truncated: boolean;
} {
  const existing = current[incoming.name];
  if (existing != null && existing.observed_at >= incoming.observed_at) {
    return { checks: { ...current }, accepted: false, truncated: false };
  }
  const next: Record<string, CiCheckFact> = { ...current, [incoming.name]: incoming };
  let truncated = false;
  while (Object.keys(next).length > maxChecks) {
    truncated = true;
    let evict: string | undefined;
    let oldest = "";
    for (const [name, fact] of Object.entries(next)) {
      if (name === incoming.name) continue;
      if (evict == null || fact.observed_at < oldest) {
        evict = name;
        oldest = fact.observed_at;
      }
    }
    if (evict == null) break;
    delete next[evict];
  }
  return { checks: next, accepted: true, truncated };
}

export function coerceRollupForIncompleteListing(
  rollup: CiRollup,
  checkRunsComplete: boolean | undefined,
): CiRollup {
  if (checkRunsComplete === false && (rollup === "none" || rollup === "passing")) {
    return "unknown";
  }
  return rollup;
}

export function isMaterialCiFactChange(
  previous: CiCheckFact | undefined,
  next: CiCheckFact,
): boolean {
  if (previous == null) return true;
  return (
    previous.status !== next.status ||
    previous.conclusion !== next.conclusion ||
    previous.check_run_id !== next.check_run_id
  );
}

export function pickSnapshotFactForName(
  facts: readonly CiCheckFact[],
  stored: CiCheckFact | undefined,
): CiCheckFact | undefined {
  if (facts.length === 0) return undefined;
  if (stored?.check_run_id != null && isCheckFactPending(stored)) {
    const match = facts.find((fact) => fact.check_run_id === stored.check_run_id);
    if (match != null) return match;
  }
  return facts[facts.length - 1];
}

export type GithubSnapshotObservation = "epoch" | "github";

export function buildCiFactsFromGithubSnapshot(
  checkRuns: readonly CiCheckRunSnapshot[],
  legacyStatuses: readonly CiLegacyStatus[],
  identity: OwnCheckIdentity,
  observation: GithubSnapshotObservation,
): CiCheckFact[] {
  const facts: CiCheckFact[] = [];
  for (const run of checkRuns) {
    const observedAt =
      observation === "github"
        ? observedAtFromGithub(run.completedAt, run.startedAt)
        : SNAPSHOT_OBSERVED_AT;
    const fact = checkRunSnapshotToFact(run, observedAt);
    if (isOwnCiCheck(identity, fact)) continue;
    facts.push(fact);
  }
  for (const status of legacyStatuses) {
    if (status.context === OWN_COMMIT_STATUS_CONTEXT) continue;
    const observedAt =
      observation === "github"
        ? observedAtFromGithub(status.updatedAt, status.createdAt)
        : SNAPSHOT_OBSERVED_AT;
    facts.push(legacyStatusToFact(status, observedAt));
  }
  return facts;
}

export type GithubSnapshotMergeMode = "initial-seed" | "pending-refresh";

export function mergeGithubSnapshotIntoChecks(input: {
  readonly stored: Readonly<Record<string, CiCheckFact>>;
  readonly storedTruncated: boolean;
  readonly checkRuns: readonly CiCheckRunSnapshot[];
  readonly legacyStatuses: readonly CiLegacyStatus[];
  readonly identity: OwnCheckIdentity;
  readonly checkRunsComplete?: boolean;
  readonly maxChecks: number;
  readonly mode: GithubSnapshotMergeMode;
}): {
  readonly checks: Record<string, CiCheckFact>;
  readonly truncated: boolean;
  readonly rollup: CiRollup;
  readonly materialChange: boolean;
} {
  const facts = buildCiFactsFromGithubSnapshot(
    input.checkRuns,
    input.legacyStatuses,
    input.identity,
    input.mode === "pending-refresh" ? "github" : "epoch",
  );
  let checks = { ...input.stored };
  let truncated = input.storedTruncated;
  let materialChange = false;

  if (input.mode === "initial-seed") {
    for (const fact of facts) {
      const merged = applyCiCheckFact(checks, fact, input.maxChecks);
      if (!merged.accepted) continue;
      checks = merged.checks;
      truncated = truncated || merged.truncated;
    }
  } else {
    const factsByName = new Map<string, CiCheckFact[]>();
    for (const fact of facts) {
      const list = factsByName.get(fact.name) ?? [];
      list.push(fact);
      factsByName.set(fact.name, list);
    }
    for (const [name, nameFacts] of factsByName) {
      const incoming = pickSnapshotFactForName(nameFacts, input.stored[name]);
      if (incoming == null) continue;
      const existing = checks[name];
      if (existing != null && existing.source !== incoming.source) continue;
      const merged = applyCiCheckFact(checks, incoming, input.maxChecks);
      if (!merged.accepted) continue;
      if (isMaterialCiFactChange(existing, incoming)) materialChange = true;
      checks = merged.checks;
      truncated = truncated || merged.truncated;
    }
  }

  return {
    checks,
    truncated,
    rollup: coerceRollupForIncompleteListing(
      classifySnapshot(Object.values(checks)),
      input.checkRunsComplete,
    ),
    materialChange,
  };
}
