import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { readRow, readRows } from "./db.ts";
import type { CiSourceAccess, CiSourceAvailability } from "../review/ci/ciFacts.ts";
import type {
  InstallationCapabilities,
  InstallationOperation,
} from "../github/installationCapabilities.ts";

export type GithubCapabilities = Partial<InstallationCapabilities["availability"]>;

export type GithubCapabilityObservation = {
  readonly generation: number;
  readonly capabilities: GithubCapabilities;
};

export type GithubRepositoryScope = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
};
export type GithubHeadScope = GithubRepositoryScope & { readonly headSha: string };
export type GithubCiSourceAvailability = CiSourceAvailability & { readonly generation: number };

const sources = ["checks", "statuses"] as const;
type Source = (typeof sources)[number];

export type HeadCiSourceState = {
  readonly access: CiSourceAccess;
  readonly listingRequired: boolean;
  readonly unknownReadCount: number;
  readonly generation: number;
};

type SourcesJson = Partial<Record<Source, HeadCiSourceState>>;

const CAPABILITY_FANOUT_BATCH_SIZE = 100;
let observationGeneration = 0;

export function nextGithubCapabilityObservationGeneration(db: DatabaseSync) {
  const stored = readRow(
    db.prepare(`SELECT MAX(generation) AS generation FROM github_repository_capabilities`).get(),
    v.object({ generation: v.nullable(v.number()) }),
  );
  observationGeneration = Math.max(observationGeneration, stored?.generation ?? 0) + 1;
  return ((pinnedReturn: number) => pinnedReturn)(observationGeneration);
}

function repoKey(scope: GithubRepositoryScope) {
  return `${scope.owner}/${scope.repo}`;
}

export function loadGithubCapabilityObservation(db: DatabaseSync, scope: GithubRepositoryScope) {
  const row = readRow(
    db
      .prepare(
        `SELECT capabilities_json, generation FROM github_repository_capabilities
        WHERE installation_id = ? AND repo_key = ?`,
      )
      .get(scope.installationId, repoKey(scope)),
    v.object({
      capabilities_json: v.optional(v.string()),
      generation: v.optional(v.number()),
    }),
  );
  if (row?.capabilities_json == null)
    return ((pinnedReturn: GithubCapabilityObservation | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: GithubCapabilityObservation | undefined) => pinnedReturn)({
    generation: typeof row.generation === "number" ? row.generation : 0,
    capabilities: v.parse(
      v.custom<GithubCapabilities>((value) => typeof value === "object" && value !== null),
      JSON.parse(row.capabilities_json),
    ),
  });
}

function readSourcesJson(db: DatabaseSync, scope: GithubHeadScope) {
  const row = readRow(
    db
      .prepare(`SELECT sources_json FROM pr_head_ci_state WHERE repo_key = ? AND head_sha = ?`)
      .get(repoKey(scope), scope.headSha),
    v.object({ sources_json: v.optional(v.string()) }),
  );
  const empty: SourcesJson = {};
  if (row?.sources_json == null) return empty;
  try {
    return ((pinnedReturn: SourcesJson) => pinnedReturn)(
      v.parse(
        v.custom<SourcesJson>((value) => typeof value === "object" && value !== null),
        JSON.parse(row.sources_json),
      ),
    );
  } catch {
    return ((pinnedReturn: SourcesJson) => pinnedReturn)(empty);
  }
}

function writeSourcesJson(
  db: DatabaseSync,
  scope: GithubHeadScope,
  sourcesJson: SourcesJson,
  now: number,
) {
  db.prepare(
    `UPDATE pr_head_ci_state SET sources_json = ?, updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(JSON.stringify(sourcesJson), now, repoKey(scope), scope.headSha);
}

function syncSources(
  db: DatabaseSync,
  scope: GithubHeadScope,
  observation: GithubCapabilityObservation | undefined,
  now: number,
) {
  const generation = observation?.generation ?? 0;
  const sourcesJson = readSourcesJson(db, scope);
  let changed = false;
  let reopened = false;
  for (const source of sources) {
    const access =
      observation?.capabilities[source === "checks" ? "checksRead" : "statusesRead"] ?? "unknown";
    const prior = sourcesJson[source];
    if (
      prior !== undefined &&
      prior.generation > generation &&
      !(prior.generation === generation && access === "denied" && prior.access !== "denied")
    ) {
      continue;
    }
    const accessChanged = prior === undefined || prior.access !== access;
    if (accessChanged) changed = true;
    if (prior?.access === "unknown" && prior.unknownReadCount > 0) reopened = true;
    sourcesJson[source] = {
      access,
      generation,
      listingRequired: accessChanged ? true : (prior?.listingRequired ?? true),
      unknownReadCount: 0,
    };
  }
  if (changed || reopened) {
    writeSourcesJson(db, scope, sourcesJson, now);
    db.prepare(
      `UPDATE pr_head_ci_state SET generation = generation + ?, updated_at = ?
        WHERE repo_key = ? AND head_sha = ?`,
    ).run(changed ? 1 : 0, now, repoKey(scope), scope.headSha);
  }
}

export function saveGithubCapabilityObservation(
  db: DatabaseSync,
  input: GithubRepositoryScope & {
    readonly observation: GithubCapabilityObservation | InstallationCapabilities;
    readonly now: number;
  },
) {
  const observation: GithubCapabilityObservation =
    "availability" in input.observation
      ? {
          generation: Number(input.observation.generation),
          capabilities: input.observation.availability,
        }
      : input.observation;
  if (!Number.isSafeInteger(observation.generation) || observation.generation < 0) {
    throw new Error("GitHub capability observation requires an ordered numeric generation");
  }
  const existing = loadGithubCapabilityObservation(db, input);
  if (existing !== undefined && existing.generation >= observation.generation) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const merged: GithubCapabilities = { ...observation.capabilities };
  if (existing !== undefined) {
    for (const [key, value] of Object.entries(existing.capabilities)) {
      const mergedRecord: Record<string, unknown> = merged;
      if (value === "denied" && mergedRecord[key] === "unknown") {
        mergedRecord[key] = value;
      }
    }
  }
  db.prepare(
    `INSERT INTO github_repository_capabilities (installation_id, repo_key, capabilities_json, generation, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (installation_id, repo_key) DO UPDATE
       SET capabilities_json = excluded.capabilities_json,
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
  ).run(
    input.installationId,
    repoKey(input),
    JSON.stringify(merged),
    observation.generation,
    input.now,
  );
  const heads = readRows(
    db
      .prepare(
        `SELECT head_sha FROM pr_head_ci_state
        WHERE repo_key = ? ORDER BY head_sha LIMIT ?`,
      )
      .all(repoKey(input), CAPABILITY_FANOUT_BATCH_SIZE),
    v.object({ head_sha: v.string() }),
  );
  for (const head of heads) {
    syncSources(
      db,
      { ...input, headSha: head.head_sha },
      { generation: observation.generation, capabilities: merged },
      input.now,
    );
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

export function recordGithubCapabilityDenial(
  db: DatabaseSync,
  input: GithubRepositoryScope & {
    readonly generation: number;
    readonly operation: InstallationOperation;
    readonly now: number;
  },
) {
  const existing = loadGithubCapabilityObservation(db, input);
  if (existing === undefined || existing.generation !== input.generation) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const existingCaps: Record<string, unknown> = existing.capabilities;
  if (existingCaps[input.operation] === "denied") {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const capabilities: GithubCapabilities = {
    ...existing.capabilities,
    [input.operation]: "denied",
  };
  db.prepare(
    `UPDATE github_repository_capabilities SET capabilities_json = ?, updated_at = ?
      WHERE installation_id = ? AND repo_key = ?`,
  ).run(JSON.stringify(capabilities), input.now, input.installationId, repoKey(input));
  const heads = readRows(
    db
      .prepare(
        `SELECT head_sha FROM pr_head_ci_state
        WHERE repo_key = ? ORDER BY head_sha LIMIT ?`,
      )
      .all(repoKey(input), CAPABILITY_FANOUT_BATCH_SIZE),
    v.object({ head_sha: v.string() }),
  );
  for (const head of heads) {
    syncSources(
      db,
      { ...input, headSha: head.head_sha },
      { generation: input.generation, capabilities },
      input.now,
    );
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

export function loadGithubCiSourceAvailability(db: DatabaseSync, scope: GithubHeadScope) {
  const observation = loadGithubCapabilityObservation(db, scope);
  const sourcesJson = readSourcesJson(db, scope);
  const sourceState = (source: Source) => {
    const row = sourcesJson[source];
    return {
      access:
        row?.access ??
        observation?.capabilities[source === "checks" ? "checksRead" : "statusesRead"] ??
        "unknown",
      listingRequired: row?.listingRequired ?? true,
      unknownReadCount: row?.unknownReadCount ?? 0,
    };
  };
  return ((pinnedReturn: GithubCiSourceAvailability) => pinnedReturn)({
    checks: sourceState("checks"),
    statuses: sourceState("statuses"),
    generation: observation?.generation ?? 0,
  });
}

export function recordGithubCiSourceRead(
  db: DatabaseSync,
  input: GithubHeadScope & {
    readonly source: Source;
    readonly generation: number;
    readonly access: CiSourceAccess;
    readonly complete: boolean;
    readonly now: number;
  },
) {
  syncSources(db, input, loadGithubCapabilityObservation(db, input), input.now);
  const sourcesJson = readSourcesJson(db, input);
  const prior = sourcesJson[input.source];
  if (prior === undefined || prior.generation !== input.generation)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (prior.access === "denied" && input.access !== "denied")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const listingRequired = !(input.access === "available" && input.complete);
  const changed = prior.access !== input.access || prior.listingRequired !== listingRequired;
  if (!changed && input.access !== "unknown")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  sourcesJson[input.source] = {
    access: input.access,
    listingRequired,
    unknownReadCount: input.access === "unknown" ? prior.unknownReadCount + 1 : 0,
    generation: prior.generation,
  };
  writeSourcesJson(db, input, sourcesJson, input.now);
  if (changed) {
    db.prepare(
      `UPDATE pr_head_ci_state
          SET state_json = json_set(state_json, '$.version', json_extract(state_json, '$.version') + 1),
              updated_at = ?
        WHERE repo_key = ? AND head_sha = ?`,
    ).run(input.now, repoKey(input), input.headSha);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(changed);
}
