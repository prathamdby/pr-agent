import type { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { AppError } from "../errors/appError.ts";
import {
  applyCiCheckFact,
  ciCheckFactSchema,
  ciSummaryFromFacts,
  headCiFactsAreComplete,
  waitingCiSummary,
  type RenderableHeadCi,
  classifySnapshot,
  mergeGithubSnapshotIntoChecks,
  type CiCheckFact,
  type CiCheckRunSnapshot,
  type CiLegacyStatus,
  type CiRollup,
  type CiSourceAvailability,
} from "../review/ci/ciFacts.ts";
import { CI_STATE_MAX_CHECKS } from "../settings/reviewConstants.ts";
import { AUTOMATED_PR_ACTIONS, DEFERRED_HEAD_SHA } from "../settings/index.ts";
import { randomUUID } from "node:crypto";
import { immediate, readRow, readRows } from "./db.ts";
import { insertWorkRun } from "./workRuns.ts";
import { loadGithubCiSourceAvailability } from "./githubCapabilities.ts";

export {
  asPrNumbers,
  headCiListingPhase,
  headCiNeedsSeed,
  isEffectiveVerificationSignalTransition,
} from "../agentWork/prHeadCiState.ts";
export type { HeadCiListingPhase, VerificationSignalPrior } from "../agentWork/prHeadCiState.ts";

export type HeadCiStateDoc = {
  readonly checks: Record<string, CiCheckFact>;
  readonly rollup: CiRollup;
  readonly version: number;
  readonly authored: unknown;
  readonly prNumbers: unknown;
  readonly truncated: boolean;
  readonly firstSeenAt: number;
};

export type HeadCiRow = {
  readonly repoKey: string;
  readonly headSha: string;
  readonly installationId: number;
  readonly state: HeadCiStateDoc;
  readonly seededAt: number | null;
  readonly nextProjectionAt: number | null;
  readonly updatedAt: number;
};

const storedRowSchema = v.object({
  repo_key: v.string(),
  head_sha: v.string(),
  installation_id: v.number(),
  state_json: v.string(),
  seeded_at: v.nullable(v.number()),
  next_projection_at: v.nullable(v.number()),
  updated_at: v.number(),
});
type StoredRow = v.InferOutput<typeof storedRowSchema>;

const headProjectionRowSchema = v.object({
  repo_key: v.string(),
  head_sha: v.string(),
  installation_id: v.number(),
});
const headShaRowSchema = v.object({ head_sha: v.optional(v.string()) });
const sourcesJsonRowSchema = v.object({ sources_json: v.optional(v.string()) });

function toHeadCiRow(row: StoredRow) {
  return ((pinnedReturn: HeadCiRow) => pinnedReturn)({
    repoKey: row.repo_key,
    headSha: row.head_sha,
    installationId: row.installation_id,
    state: v.parse(
      v.custom<HeadCiStateDoc>((value) => typeof value === "object" && value !== null),
      JSON.parse(row.state_json),
    ),
    seededAt: row.seeded_at,
    nextProjectionAt: row.next_projection_at,
    updatedAt: row.updated_at,
  });
}

export function loadPrHeadCiState(
  db: DatabaseSync,
  params: { readonly repoKey: string; readonly headSha: string },
) {
  const row = readRow(
    db
      .prepare(`SELECT * FROM pr_head_ci_state WHERE repo_key = ? AND head_sha = ?`)
      .get(params.repoKey, params.headSha),
    storedRowSchema,
  );
  if (row === undefined) return ((pinnedReturn: HeadCiRow | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: HeadCiRow | undefined) => pinnedReturn)(toHeadCiRow(row));
}

export type ApplyPrHeadCiFactInput = {
  readonly installationId: number;
  readonly repoKey: string;
  readonly headSha: string;
  readonly fact: CiCheckFact;
};

export type ApplyPrHeadCiFactResult = {
  readonly accepted: boolean;
  readonly version: number;
  readonly previousRollup: CiRollup;
  readonly rollup: CiRollup;
};

const EMPTY_SOURCES = "{}";

function ensureHeadRow(
  db: DatabaseSync,
  params: { readonly installationId: number; readonly repoKey: string; readonly headSha: string },
  now: number,
) {
  const blank: HeadCiStateDoc = {
    checks: {},
    rollup: "none",
    version: 0,
    authored: null,
    prNumbers: null,
    truncated: false,
    firstSeenAt: now,
  };
  db.prepare(
    `INSERT INTO pr_head_ci_state
      (repo_key, head_sha, installation_id, state_json, sources_json, seeded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (repo_key, head_sha) DO NOTHING`,
  ).run(
    params.repoKey,
    params.headSha,
    params.installationId,
    JSON.stringify(blank),
    EMPTY_SOURCES,
    now,
  );
  const row = readRow(
    db
      .prepare(`SELECT * FROM pr_head_ci_state WHERE repo_key = ? AND head_sha = ?`)
      .get(params.repoKey, params.headSha),
    storedRowSchema,
  );
  if (row === undefined) {
    throw new AppError({
      domain: "ci",
      kind: "head_state_lock_missed",
      message: "pr_head_ci_state lock missed after insert",
    });
  }
  return ((pinnedReturn: HeadCiRow) => pinnedReturn)(toHeadCiRow(row));
}

export function applyPrHeadCiFactTx(
  db: DatabaseSync,
  input: ApplyPrHeadCiFactInput,
  now = Date.now(),
) {
  const row = ensureHeadRow(db, input, now);
  const previousRollup = row.state.rollup;
  const merged = applyCiCheckFact(row.state.checks, input.fact, CI_STATE_MAX_CHECKS);
  if (!merged.accepted) {
    return ((pinnedReturn: ApplyPrHeadCiFactResult) => pinnedReturn)({
      accepted: false,
      version: row.state.version,
      previousRollup,
      rollup: previousRollup,
    });
  }
  const rollup = classifySnapshot(Object.values(merged.checks));
  const nextVersion = row.state.version + 1;
  const next: HeadCiStateDoc = {
    ...row.state,
    checks: merged.checks,
    rollup,
    version: nextVersion,
    truncated: row.state.truncated || merged.truncated,
  };
  db.prepare(
    `UPDATE pr_head_ci_state SET state_json = ?, updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(JSON.stringify(next), now, input.repoKey, input.headSha);
  return ((pinnedReturn: ApplyPrHeadCiFactResult) => pinnedReturn)({
    accepted: true,
    version: nextVersion,
    previousRollup,
    rollup,
  });
}

export function applyPrHeadCiFact(
  db: DatabaseSync,
  input: ApplyPrHeadCiFactInput,
  now = Date.now(),
) {
  return immediate(db, () => applyPrHeadCiFactTx(db, input, now));
}

export function storePrHeadCiAuthored(
  db: DatabaseSync,
  params: {
    readonly installationId: number;
    readonly repoKey: string;
    readonly headSha: string;
    readonly authored: unknown;
  },
  now = Date.now(),
) {
  immediate(db, () => {
    const row = ensureHeadRow(db, params, now);
    const next: HeadCiStateDoc = { ...row.state, authored: params.authored };
    db.prepare(
      `UPDATE pr_head_ci_state SET state_json = ?, updated_at = ?
        WHERE repo_key = ? AND head_sha = ?`,
    ).run(JSON.stringify(next), now, params.repoKey, params.headSha);
  });
}

export function storePrNumbersForHead(
  db: DatabaseSync,
  params: {
    readonly installationId: number;
    readonly repoKey: string;
    readonly headSha: string;
    readonly prNumbers: readonly number[];
  },
  now = Date.now(),
) {
  immediate(db, () => {
    const row = ensureHeadRow(db, params, now);
    const next: HeadCiStateDoc = { ...row.state, prNumbers: params.prNumbers };
    db.prepare(
      `UPDATE pr_head_ci_state SET state_json = ?, updated_at = ?
        WHERE repo_key = ? AND head_sha = ?`,
    ).run(JSON.stringify(next), now, params.repoKey, params.headSha);
  });
}

export function markHeadSeeded(
  db: DatabaseSync,
  params: { readonly repoKey: string; readonly headSha: string },
  now = Date.now(),
) {
  db.prepare(
    `UPDATE pr_head_ci_state SET seeded_at = ?, updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(now, now, params.repoKey, params.headSha);
}

export function scheduleNextProjection(
  db: DatabaseSync,
  params: { readonly repoKey: string; readonly headSha: string; readonly at: number | null },
  now = Date.now(),
) {
  db.prepare(
    `UPDATE pr_head_ci_state SET next_projection_at = ?, updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(params.at, now, params.repoKey, params.headSha);
}

export function listDueProjections(db: DatabaseSync, now: number, limit: number) {
  const rows = readRows(
    db
      .prepare(
        `SELECT repo_key, head_sha, installation_id FROM pr_head_ci_state
        WHERE next_projection_at IS NOT NULL AND next_projection_at <= ?
        ORDER BY next_projection_at LIMIT ?`,
      )
      .all(now, limit),
    headProjectionRowSchema,
  );
  return ((
    pinnedReturn: readonly {
      readonly repoKey: string;
      readonly headSha: string;
      readonly installationId: number;
    }[],
  ) => pinnedReturn)(
    rows.map((row) => ({
      repoKey: row.repo_key,
      headSha: row.head_sha,
      installationId: row.installation_id,
    })),
  );
}

export function newestHeadShaForRepo(db: DatabaseSync, repoKey: string) {
  const row = readRow(
    db
      .prepare(
        `SELECT head_sha FROM pr_head_ci_state WHERE repo_key = ?
        ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(repoKey),
    headShaRowSchema,
  );
  return ((pinnedReturn: string | undefined) => pinnedReturn)(row?.head_sha);
}

export function sourceAvailabilityForHead(
  db: DatabaseSync,
  params: { readonly repoKey: string; readonly headSha: string },
) {
  const row = readRow(
    db
      .prepare(`SELECT sources_json FROM pr_head_ci_state WHERE repo_key = ? AND head_sha = ?`)
      .get(params.repoKey, params.headSha),
    sourcesJsonRowSchema,
  );
  if (row?.sources_json == null)
    return ((pinnedReturn: CiSourceAvailability | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: CiSourceAvailability | undefined) => pinnedReturn)(
    v.parse(
      v.custom<CiSourceAvailability>((value) => typeof value === "object" && value !== null),
      JSON.parse(row.sources_json),
    ),
  );
}

export function isHeadCiSeedPullRequest(action: string, headSha: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    action !== "closed" && AUTOMATED_PR_ACTIONS.has(action) && headSha !== DEFERRED_HEAD_SHA,
  );
}

export function headCiNeedsSeedForRow(row: Pick<HeadCiRow, "seededAt"> | null) {
  return ((pinnedReturn: boolean) => pinnedReturn)(row == null || row.seededAt == null);
}

export function shouldSeedHeadCiFromPullRequest(
  action: string,
  headSha: string,
  row: Pick<HeadCiRow, "seededAt"> | null,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    isHeadCiSeedPullRequest(action, headSha) && headCiNeedsSeedForRow(row),
  );
}

export type HeadCiProjectionRow = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly checks: Record<string, CiCheckFact>;
  readonly rollup: CiRollup;
  readonly version: number;
  readonly authored: unknown;
  readonly prNumbers: unknown;
  readonly truncated: boolean;
  readonly seededAt: number | null;
  readonly sourceAvailability?: CiSourceAvailability;
};

export type HeadCiRef = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
};

const checkMapSchema = v.record(v.string(), ciCheckFactSchema);
const ROLLUPS = ["pending", "passing", "failing", "none", "unknown"] as const;

function headRepoKey(head: Pick<HeadCiRef, "owner" | "repo">) {
  return ((pinnedReturn: string) => pinnedReturn)(`${head.owner}/${head.repo}`);
}

function toProjectionRow(row: HeadCiRow, head: Pick<HeadCiRef, "owner" | "repo">) {
  const checks = v.safeParse(checkMapSchema, row.state.checks);
  const rollup = v.safeParse(v.picklist(ROLLUPS), row.state.rollup);
  return ((pinnedReturn: HeadCiProjectionRow) => pinnedReturn)({
    installationId: row.installationId,
    owner: head.owner,
    repo: head.repo,
    headSha: row.headSha,
    checks: checks.success ? checks.output : {},
    rollup: rollup.success ? rollup.output : "unknown",
    version: typeof row.state.version === "number" ? row.state.version : 0,
    authored: row.state.authored,
    prNumbers: row.state.prNumbers,
    truncated: row.state.truncated,
    seededAt: row.seededAt,
  });
}

export function loadHeadCiProjectionRow(
  db: DatabaseSync,
  head: Pick<HeadCiRef, "owner" | "repo" | "headSha">,
) {
  const row = loadPrHeadCiState(db, { repoKey: headRepoKey(head), headSha: head.headSha });
  return ((pinnedReturn: HeadCiProjectionRow | null) => pinnedReturn)(
    row === undefined ? null : toProjectionRow(row, head),
  );
}

export type GithubSnapshotWriteInput = HeadCiRef & {
  readonly checkRuns: readonly CiCheckRunSnapshot[];
  readonly legacyStatuses: readonly CiLegacyStatus[];
  readonly githubAppId: string;
  readonly checkRunsComplete?: boolean;
};

function writeHeadState(db: DatabaseSync, head: HeadCiRef, next: HeadCiStateDoc, now: number) {
  db.prepare(
    `UPDATE pr_head_ci_state SET state_json = ?, updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(JSON.stringify(next), now, headRepoKey(head), head.headSha);
}

function requireProjectionRow(db: DatabaseSync, head: HeadCiRef) {
  const row = loadHeadCiProjectionRow(db, head);
  if (row === null) {
    throw new AppError({
      domain: "ci",
      kind: "head_state_missing",
      message: "pr_head_ci_state missing after GitHub snapshot write",
    });
  }
  return ((pinnedReturn: HeadCiProjectionRow) => pinnedReturn)(row);
}

export function seedHeadCiFromSnapshot(
  db: DatabaseSync,
  input: GithubSnapshotWriteInput,
  now = Date.now(),
) {
  return immediate(db, () => {
    const key = { ...input, repoKey: headRepoKey(input) };
    const stored = ensureHeadRow(db, key, now);
    const current = toProjectionRow(stored, input);
    if (stored.seededAt !== null) {
      return { row: current, previousRollup: current.rollup };
    }
    const merged = mergeGithubSnapshotIntoChecks({
      stored: current.checks,
      storedTruncated: current.truncated,
      checkRuns: input.checkRuns,
      legacyStatuses: input.legacyStatuses,
      identity: { githubAppId: input.githubAppId },
      checkRunsComplete: input.checkRunsComplete,
      maxChecks: CI_STATE_MAX_CHECKS,
      mode: "initial-seed",
    });
    writeHeadState(
      db,
      input,
      {
        ...stored.state,
        checks: merged.checks,
        rollup: merged.rollup,
        version: current.version + 1,
        truncated: merged.truncated,
      },
      now,
    );
    markHeadSeeded(db, key, now);
    return { row: requireProjectionRow(db, input), previousRollup: current.rollup };
  });
}

export function refreshHeadCiFromSnapshot(
  db: DatabaseSync,
  input: GithubSnapshotWriteInput,
  now = Date.now(),
) {
  return immediate(db, () => {
    const stored = loadPrHeadCiState(db, { repoKey: headRepoKey(input), headSha: input.headSha });
    if (stored === undefined) {
      throw new AppError({
        domain: "ci",
        kind: "head_state_missing",
        message: "pr_head_ci_state missing for pending refresh",
      });
    }
    if (stored.seededAt === null) {
      throw new AppError({
        domain: "ci",
        kind: "head_state_unseeded",
        message: "pr_head_ci_state is unseeded for pending refresh",
      });
    }
    const current = toProjectionRow(stored, input);
    const merged = mergeGithubSnapshotIntoChecks({
      stored: current.checks,
      storedTruncated: current.truncated,
      checkRuns: input.checkRuns,
      legacyStatuses: input.legacyStatuses,
      identity: { githubAppId: input.githubAppId },
      checkRunsComplete: input.checkRunsComplete,
      maxChecks: CI_STATE_MAX_CHECKS,
      mode: "pending-refresh",
    });
    const rollupChanged = merged.rollup !== current.rollup;
    const truncatedChanged = merged.truncated !== current.truncated;
    if (!merged.materialChange && !rollupChanged && !truncatedChanged) {
      return { row: current, previousRollup: current.rollup };
    }
    writeHeadState(
      db,
      input,
      {
        ...stored.state,
        checks: merged.checks,
        rollup: merged.rollup,
        version: merged.materialChange || rollupChanged ? current.version + 1 : current.version,
        truncated: merged.truncated,
      },
      now,
    );
    return { row: requireProjectionRow(db, input), previousRollup: current.rollup };
  });
}

export function storeHeadCiPrNumbers(
  db: DatabaseSync,
  head: HeadCiRef & { readonly prNumbers: readonly number[] },
  now = Date.now(),
) {
  if (head.prNumbers.length === 0) return;
  storePrNumbersForHead(db, { ...head, repoKey: headRepoKey(head) }, now);
}

export function storeHeadCiAuthored(
  db: DatabaseSync,
  head: HeadCiRef & { readonly authored: unknown },
  now = Date.now(),
) {
  storePrHeadCiAuthored(db, { ...head, repoKey: headRepoKey(head) }, now);
}

export function advanceHeadCiVersionForVerificationSignal(
  db: DatabaseSync,
  head: HeadCiRef & { readonly effective: boolean },
  now = Date.now(),
) {
  const row = ensureHeadRow(db, { ...head, repoKey: headRepoKey(head) }, now);
  const version = typeof row.state.version === "number" ? row.state.version : 0;
  if (!head.effective)
    return ((pinnedReturn: { readonly version: number; readonly bumped: boolean }) => pinnedReturn)(
      { version, bumped: false },
    );
  writeHeadState(db, head, { ...row.state, version: version + 1 }, now);
  return ((pinnedReturn: { readonly version: number; readonly bumped: boolean }) => pinnedReturn)({
    version: version + 1,
    bumped: true,
  });
}

export const CI_PROJECTION_DEBOUNCE_MS = 5_000;

export type HeadCiProjectionSchedule =
  | { readonly kind: "debounced" }
  | { readonly kind: "after"; readonly seconds: number }
  | { readonly kind: "when_due"; readonly renderedVersion: number };

export function ciProjectionDue(
  row: Pick<HeadCiProjectionRow, "seededAt" | "version"> | null,
  renderedVersion: number,
) {
  if (row === null || row.seededAt === null) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(row.version > renderedVersion);
}

export function requestHeadCiProjectionTx(
  db: DatabaseSync,
  head: HeadCiRef,
  schedule: HeadCiProjectionSchedule,
  now: number,
) {
  if (head.installationId <= 0) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const key = { ...head, repoKey: headRepoKey(head) };
  if (schedule.kind === "when_due") {
    if (!ciProjectionDue(loadHeadCiProjectionRow(db, head), schedule.renderedVersion))
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  ensureHeadRow(db, key, now);
  const at =
    schedule.kind === "after"
      ? now + Math.max(1, schedule.seconds) * 1000
      : now + CI_PROJECTION_DEBOUNCE_MS;
  db.prepare(
    `UPDATE pr_head_ci_state
        SET next_projection_at = CASE
              WHEN next_projection_at IS NULL OR next_projection_at > ? THEN ?
              ELSE next_projection_at END,
            updated_at = ?
      WHERE repo_key = ? AND head_sha = ?`,
  ).run(at, at, now, key.repoKey, head.headSha);
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

export function requestHeadCiProjection(
  db: DatabaseSync,
  head: HeadCiRef,
  schedule: HeadCiProjectionSchedule,
  now = Date.now(),
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    immediate(db, () => requestHeadCiProjectionTx(db, head, schedule, now)),
  );
}

const runPayloadSchema = v.looseObject({
  owner: v.optional(v.unknown()),
  repo: v.optional(v.unknown()),
  headSha: v.optional(v.unknown()),
  prNumber: v.optional(v.unknown()),
  mode: v.optional(v.unknown()),
});

function parseRunPayload(payloadJson: string) {
  const parsed = v.safeParse(runPayloadSchema, JSON.parse(payloadJson));
  return ((pinnedReturn: v.InferOutput<typeof runPayloadSchema> | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

export function enqueueDueCiProjections(db: DatabaseSync, now: number, limit = 32) {
  return immediate(db, () => {
    const due = listDueProjections(db, now, limit);
    const enqueued: string[] = [];
    for (const head of due) {
      const separator = head.repoKey.indexOf("/");
      const owner = head.repoKey.slice(0, separator);
      const repo = head.repoKey.slice(separator + 1);
      scheduleNextProjection(db, { repoKey: head.repoKey, headSha: head.headSha, at: null }, now);
      if (separator <= 0 || head.installationId <= 0) continue;
      const queued = readRow(
        db
          .prepare(
            `SELECT work_id FROM work_runs
              WHERE kind = 'ci_projection' AND status IN ('pending_dispatch', 'retry_scheduled')
                AND json_extract(payload_json, '$.owner') = ?
                AND json_extract(payload_json, '$.repo') = ?
                AND json_extract(payload_json, '$.headSha') = ?
              LIMIT 1`,
          )
          .get(owner, repo, head.headSha),
        v.object({ work_id: v.string() }),
      );
      if (queued !== undefined) continue;
      const workId = randomUUID();
      insertWorkRun(db, {
        workId,
        prKey: `${owner}/${repo}#${head.headSha}`,
        kind: "ci_projection",
        payloadJson: JSON.stringify({
          installationId: head.installationId,
          owner,
          repo,
          headSha: head.headSha,
        }),
        now,
      });
      enqueued.push(workId);
    }
    return ((pinnedReturn: readonly string[]) => pinnedReturn)(enqueued);
  });
}

export function nextCiProjectionDueAt(db: DatabaseSync) {
  const row = readRow(
    db
      .prepare(
        `SELECT MIN(next_projection_at) AS at FROM pr_head_ci_state WHERE next_projection_at IS NOT NULL`,
      )
      .get(),
    v.object({ at: v.nullable(v.number()) }),
  );
  return ((pinnedReturn: number | null) => pinnedReturn)(row?.at ?? null);
}

export function listPrNumbersForHeadFromRuns(
  db: DatabaseSync,
  head: Pick<HeadCiRef, "owner" | "repo" | "headSha">,
) {
  const rows = readRows(
    db
      .prepare(
        `SELECT DISTINCT json_extract(payload_json, '$.prNumber') AS pr_number FROM work_runs
          WHERE json_extract(payload_json, '$.owner') = ?
            AND json_extract(payload_json, '$.repo') = ?
            AND json_extract(payload_json, '$.headSha') = ?
            AND json_extract(payload_json, '$.prNumber') IS NOT NULL
          ORDER BY pr_number`,
      )
      .all(head.owner, head.repo, head.headSha),
    v.object({ pr_number: v.unknown() }),
  );
  return ((pinnedReturn: number[]) => pinnedReturn)(
    rows.flatMap((row) =>
      typeof row.pr_number === "number" && Number.isInteger(row.pr_number) && row.pr_number > 0
        ? [row.pr_number]
        : [],
    ),
  );
}

export function newestHeadShaForPr(db: DatabaseSync, prKey: string) {
  const rows = readRows(
    db
      .prepare(
        `SELECT payload_json FROM work_runs WHERE pr_key = ? ORDER BY created_at DESC LIMIT 16`,
      )
      .all(prKey),
    v.object({ payload_json: v.string() }),
  );
  for (const row of rows) {
    const headSha = parseRunPayload(row.payload_json)?.headSha;
    if (typeof headSha === "string" && headSha.length > 0 && headSha !== DEFERRED_HEAD_SHA)
      return ((pinnedReturn: string | null) => pinnedReturn)(headSha);
  }
  return ((pinnedReturn: string | null) => pinnedReturn)(null);
}

export type TerminalReviewForHead = {
  readonly id: string;
  readonly status: "completed" | "failed" | "cancelled" | "superseded";
  readonly resourceKey: string;
  readonly reviewLens: string;
  readonly prNumber: number;
  readonly headSha: string;
};

export function listTerminalReviewsForHead(
  db: DatabaseSync,
  params: { readonly prKey: string; readonly prNumber: number; readonly headSha: string },
) {
  const rows = readRows(
    db
      .prepare(
        `SELECT work_id, status, payload_json FROM work_runs
          WHERE pr_key = ? AND kind = 'review'
            AND status IN ('completed', 'failed', 'cancelled', 'superseded')`,
      )
      .all(params.prKey),
    v.object({
      work_id: v.string(),
      status: v.picklist(["completed", "failed", "cancelled", "superseded"]),
      payload_json: v.string(),
    }),
  );
  return ((pinnedReturn: readonly TerminalReviewForHead[]) => pinnedReturn)(
    rows.flatMap((row) => {
      const payload = parseRunPayload(row.payload_json);
      const headSha = payload?.headSha;
      const lens = payload?.mode;
      if (headSha !== params.headSha || typeof lens !== "string") return [];
      return [
        {
          id: row.work_id,
          status: row.status,
          resourceKey: params.prKey,
          reviewLens: lens,
          prNumber: params.prNumber,
          headSha: params.headSha,
        },
      ];
    }),
  );
}

export function loadRenderableHeadCi(
  db: DatabaseSync,
  head: Pick<HeadCiRef, "owner" | "repo" | "headSha"> & { readonly installationId?: number },
) {
  const sourceAvailability =
    head.installationId == null
      ? undefined
      : loadGithubCiSourceAvailability(db, { ...head, installationId: head.installationId });
  const row = loadHeadCiProjectionRow(db, head);
  if (row === null) return ((pinnedReturn: RenderableHeadCi) => pinnedReturn)(waitingCiSummary(0));
  if (
    row.seededAt === null &&
    sourceAvailability?.checks.access !== "denied" &&
    sourceAvailability?.statuses.access !== "denied"
  )
    return ((pinnedReturn: RenderableHeadCi) => pinnedReturn)(waitingCiSummary(row.version));
  return ((pinnedReturn: RenderableHeadCi) => pinnedReturn)(
    ciSummaryFromFacts(row.checks, row.version, row.authored, {
      checkRunsComplete: headCiFactsAreComplete(row.rollup),
      sourceAvailability,
    }),
  );
}
