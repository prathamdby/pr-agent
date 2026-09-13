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

export const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
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
    app_id: null,
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
