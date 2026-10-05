import { createHash } from "node:crypto";
import * as v from "valibot";
import {
  OWN_COMMIT_STATUS_CONTEXT,
  REVIEW_CI_SUMMARY_INCOMPLETE,
  REVIEW_CI_SUMMARY_UNAVAILABLE,
} from "../../settings/index.js";

/**
 * CI gate for the review summary / progress stub (not part of ReviewPayload).
 * Status, names, and check-run completeness are server facts; headline/reason/fixHint
 * are LLM-authored when failing (ADR 0018). Passing/pending/none use server templates.
 * An incomplete check-run view never becomes passing or none.
 */

export type CiSummaryStatus = "passing" | "failing" | "pending" | "none" | "unavailable";

export type CiSourceAccess = "available" | "denied" | "unknown";
export type CiSourceAvailabilityState = {
  readonly access: CiSourceAccess;
  readonly listingRequired: boolean;
  readonly unknownReadCount?: number;
};
export type CiSourceAvailability = {
  readonly checks: CiSourceAvailabilityState;
  readonly statuses: CiSourceAvailabilityState;
};

export function ciSourcesComplete(availability: CiSourceAvailability): boolean {
  return [availability.checks, availability.statuses].every(
    (source) => source.access === "available" && !source.listingRequired,
  );
}

export type CiFailureDetail = {
  /** Check run or status context name. */
  readonly name: string;
  /** One-line root cause when known. */
  readonly reason: string;
  /** Short fix direction for humans and coding agents. */
  readonly fixHint: string;
  /** Optional deep-link to the failing check run. */
  readonly url?: string;
};

export type CiSummary = {
  readonly status: CiSummaryStatus;
  /** Short lead for the CI table cell. */
  readonly headline: string;
  /** Failure digests (empty unless status is failing). */
  readonly failures: readonly CiFailureDetail[];
  /**
   * Optional install hint when Checks or Actions permission is missing.
   * Shown under the headline; review still publishes.
   */
  readonly permissionNote?: string;
};

export type CiCheckRunSnapshot = {
  readonly id: number;
  readonly name: string;
  /** Provider identity for durable PR Agent check-run recovery, when returned. */
  readonly externalId?: string | null;
  /** GitHub App id that created the check run, when returned. */
  readonly appId?: number | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string | null;
  readonly outputTitle: string | null;
  readonly outputSummary: string | null;
  readonly outputText: string | null;
  /** Checks API `started_at`, when returned. Used for pending-refresh `observed_at`. */
  readonly startedAt?: string | null;
  /** Checks API `completed_at`, when returned. Used for pending-refresh `observed_at`. */
  readonly completedAt?: string | null;
};

export type CiLegacyStatus = {
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  readonly targetUrl: string | null;
  /** Combined-status `updated_at`, when returned. Used for pending-refresh `observed_at`. */
  readonly updatedAt?: string | null;
  /** Combined-status `created_at`, when returned. Used for pending-refresh `observed_at`. */
  readonly createdAt?: string | null;
};

export type CiFactSource = "check_run" | "status";

/** Derived rollup stored on `pr_head_ci_state`. */
export type CiRollup = "pending" | "passing" | "failing" | "none" | "unknown";

export const ciCheckFactSchema = v.object({
  name: v.string(),
  source: v.picklist(["check_run", "status"]),
  status: v.string(),
  conclusion: v.nullable(v.string()),
  url: v.nullable(v.string()),
  external_id: v.nullable(v.string()),
  app_id: v.nullable(v.number()),
  check_run_id: v.nullable(v.number()),
  observed_at: v.string(),
});

export type CiCheckFact = Readonly<v.InferOutput<typeof ciCheckFactSchema>>;

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

function isCheckFailing(run: CiCheckRunSnapshot): boolean {
  return isCheckFactFailing(checkRunSnapshotToFact(run));
}

function isLegacyFailing(status: CiLegacyStatus): boolean {
  return isCheckFactFailing(legacyStatusToFact(status));
}

function unavailableSummary(headline: string): CiSummary {
  return {
    status: "unavailable",
    headline,
    failures: [],
  };
}

function withPartialCiView(headline: string): string {
  return headline.includes("(partial CI view)") ? headline : `${headline} (partial CI view)`;
}

export function summarizeCiSnapshot(params: {
  readonly checks: readonly CiCheckRunSnapshot[];
  readonly statuses: readonly CiLegacyStatus[];
  readonly failures?: CiSummary["failures"];
  readonly permissionNote?: string;
  readonly checkRunsComplete?: boolean;
  readonly legacyStatusesComplete?: boolean;
  readonly sourceAvailability?: CiSourceAvailability;
}): CiSummary {
  const state = classifyGithubSnapshot(params.checks, params.statuses);
  const unavailableSources =
    params.sourceAvailability == null
      ? []
      : (["checks", "statuses"] as const).filter(
          (source) =>
            params.sourceAvailability?.[source].access !== "available" ||
            params.sourceAvailability?.[source].listingRequired,
        );
  const permissionNote =
    unavailableSources.length > 0
      ? `Partial CI view: ${unavailableSources.join(" and ")} unavailable.${params.permissionNote == null ? "" : ` ${params.permissionNote}`}`
      : params.permissionNote;
  const incomplete =
    params.checkRunsComplete === false ||
    params.legacyStatusesComplete === false ||
    unavailableSources.length > 0;
  if (incomplete && (state === "none" || state === "passing")) {
    return {
      ...unavailableSummary(REVIEW_CI_SUMMARY_INCOMPLETE),
      ...(permissionNote != null ? { permissionNote } : {}),
    };
  }
  switch (state) {
    case "none":
      return {
        status: "none",
        headline: "No CI checks on this head",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    case "pending":
      return {
        status: "pending",
        headline: incomplete ? withPartialCiView("⏳ CI still running") : "⏳ CI still running",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    case "passing":
      return {
        status: "passing",
        headline: "✅ All CI is passing",
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    case "failing": {
      const failures = params.failures ?? [];
      const failingNames = [
        ...params.checks.filter(isCheckFailing).map((run) => run.name),
        ...params.statuses.filter(isLegacyFailing).map((status) => status.context),
      ];
      const uniqueNames = [...new Set(failingNames)];
      const nameList = uniqueNames.slice(0, 3).join(", ");
      const more = uniqueNames.length > 3 ? ` (+${uniqueNames.length - 3} more)` : "";
      const headline = `❌ CI failing — ${nameList}${more}`;
      return {
        status: "failing",
        headline: incomplete ? withPartialCiView(headline) : headline,
        failures,
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    }
    case "unknown":
      return {
        status: "unavailable",
        headline: REVIEW_CI_SUMMARY_UNAVAILABLE,
        failures: [],
        ...(permissionNote != null ? { permissionNote } : {}),
      };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function summarizeCiFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  options?: {
    readonly checkRunsComplete?: boolean;
    readonly sourceAvailability?: CiSourceAvailability;
  },
): CiSummary {
  const checkRuns: CiCheckRunSnapshot[] = [];
  const statuses: CiLegacyStatus[] = [];
  for (const fact of Object.values(checks)) {
    if (fact.source === "status") {
      statuses.push({
        context: fact.name,
        state: fact.status,
        description: null,
        targetUrl: fact.url,
      });
    } else {
      checkRuns.push({
        id: fact.check_run_id ?? 0,
        name: fact.name,
        externalId: fact.external_id,
        status: fact.status,
        conclusion: fact.conclusion,
        htmlUrl: fact.url,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      });
    }
  }
  return summarizeCiSnapshot({
    checks: checkRuns,
    statuses,
    checkRunsComplete: options?.checkRunsComplete,
    sourceAvailability: options?.sourceAvailability,
  });
}

export function isOwnCommitStatusContext(context: string): boolean {
  return context === OWN_COMMIT_STATUS_CONTEXT;
}

export type CiAuthoredCache = {
  readonly factsHash: string;
  readonly headline: string;
  readonly failures: readonly CiFailureDetail[];
  readonly permissionNote?: string;
  readonly authoredAt: string;
};

const failureSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  reason: v.string(),
  fixHint: v.string(),
  url: v.optional(v.string()),
});

const authoredSchema = v.object({
  factsHash: v.pipe(v.string(), v.minLength(1)),
  headline: v.pipe(v.string(), v.minLength(1)),
  failures: v.array(failureSchema),
  permissionNote: v.optional(v.string()),
  authoredAt: v.pipe(v.string(), v.minLength(1)),
});

export function hashCiFacts(checks: Readonly<Record<string, CiCheckFact>>): string {
  const lines = Object.values(checks)
    .map((fact) => [fact.name, fact.source, fact.status, fact.conclusion ?? ""].join("\0"))
    .toSorted();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function parseCiAuthoredCache(value: unknown): CiAuthoredCache | null {
  const parsed = v.safeParse(authoredSchema, value);
  return parsed.success ? parsed.output : null;
}

export const WAITING_FOR_CI_SUMMARY: CiSummary = {
  status: "pending",
  headline: "⏳ Waiting for CI",
  failures: [],
};

export type RenderableHeadCi = {
  readonly summary: CiSummary;
  readonly version: number;
};

export function headCiFactsAreComplete(rollup: CiRollup): boolean {
  return rollup !== "unknown";
}

export function ciSummaryFromFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  version: number,
  authored?: unknown,
  options?: {
    readonly checkRunsComplete?: boolean;
    readonly sourceAvailability?: CiSourceAvailability;
  },
): RenderableHeadCi {
  const facts = summarizeCiFacts(checks, options);
  const cache = parseCiAuthoredCache(authored);
  if (facts.status === "failing" && cache != null && cache.factsHash === hashCiFacts(checks)) {
    return {
      summary: {
        status: "failing",
        headline: facts.headline.includes("(partial CI view)")
          ? withPartialCiView(cache.headline)
          : cache.headline,
        failures: cache.failures,
        ...(facts.permissionNote != null
          ? { permissionNote: facts.permissionNote }
          : cache.permissionNote != null
            ? { permissionNote: cache.permissionNote }
            : {}),
      },
      version,
    };
  }
  return { summary: facts, version };
}

export function waitingCiSummary(version = 0): RenderableHeadCi {
  return { summary: WAITING_FOR_CI_SUMMARY, version };
}
