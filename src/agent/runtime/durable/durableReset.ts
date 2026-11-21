import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { mutatingIntents } from "../../../state/publish.ts";
import { liveAttemptCounts } from "../../../state/workRuns.ts";
import {
  PI_DURABLE_DB_FILENAME,
  PI_DURABLE_EPOCH_FILENAME,
  PI_DURABLE_FILE_SUFFIXES,
  piDurableCreatedAt,
} from "./harness.ts";
import type { DurableRuntime } from "./runtime.ts";

export const PI_DURABLE_ARCHIVE_DIRNAME = "archive";
const QUIESCENCE_POLL_MS = 250;

export type PiDurableResetReason = "size" | "age";

export type QuiescenceReport = {
  readonly ok: boolean;
  readonly liveAttempts: number;
  readonly mutatingIntents: number;
  readonly liveTasks: number;
  readonly unsettledSubmissions: number;
};

export type PiDurableResetOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "not_due"; readonly bytes: number; readonly ageMs: number }
  | {
      readonly kind: "not_quiescent";
      readonly reason: PiDurableResetReason;
      readonly detail: QuiescenceReport;
    }
  | {
      readonly kind: "reset";
      readonly reason: PiDurableResetReason;
      readonly archiveDir: string;
      readonly archived: readonly string[];
      readonly runtime: DurableRuntime;
    };

async function fileSize(path: string) {
  try {
    return ((pinnedReturn: number) => pinnedReturn)((await stat(path)).size);
  } catch {
    return ((pinnedReturn: number) => pinnedReturn)(0);
  }
}

export async function piDurableResetDue(params: {
  readonly sqliteDir: string;
  readonly maxBytes: number;
  readonly maxAgeSeconds: number;
  readonly now: number;
}) {
  const base = join(params.sqliteDir, PI_DURABLE_DB_FILENAME);
  let bytes = 0;
  for (const suffix of PI_DURABLE_FILE_SUFFIXES) bytes += await fileSize(`${base}${suffix}`);
  const ageMs = params.now - (await piDurableCreatedAt(params.sqliteDir, params.now));
  const reason: PiDurableResetReason | undefined =
    bytes > params.maxBytes ? "size" : ageMs > params.maxAgeSeconds * 1000 ? "age" : undefined;
  return ((pinnedReturn: {
    readonly reason: PiDurableResetReason | undefined;
    readonly bytes: number;
    readonly ageMs: number;
  }) => pinnedReturn)({ reason, bytes, ageMs });
}

export async function verifyQuiescent(params: {
  readonly db: DatabaseSync;
  readonly runtime: DurableRuntime;
  readonly context?: Context;
}) {
  const inspection = await params.runtime.handle.harness.inspect(
    params.context ?? BACKGROUND_CONTEXT,
  );
  const report = {
    liveAttempts: liveAttemptCounts(params.db),
    mutatingIntents: mutatingIntents(params.db).length,
    liveTasks: inspection.tasks.length,
    unsettledSubmissions: inspection.submissions.length,
  };
  return ((pinnedReturn: QuiescenceReport) => pinnedReturn)({
    ...report,
    ok:
      report.liveAttempts === 0 &&
      report.mutatingIntents === 0 &&
      report.liveTasks === 0 &&
      report.unsettledSubmissions === 0,
  });
}

export async function archivePiDurableFiles(sqliteDir: string, now: number) {
  const archiveDir = join(
    sqliteDir,
    PI_DURABLE_ARCHIVE_DIRNAME,
    new Date(now).toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(archiveDir, { recursive: true });
  const archived: string[] = [];
  const names = [
    ...PI_DURABLE_FILE_SUFFIXES.map((suffix) => `${PI_DURABLE_DB_FILENAME}${suffix}`),
    PI_DURABLE_EPOCH_FILENAME,
  ];
  for (const name of names) {
    try {
      await rename(join(sqliteDir, name), join(archiveDir, name));
      archived.push(name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return ((pinnedReturn: { readonly archiveDir: string; readonly archived: readonly string[] }) =>
    pinnedReturn)({ archiveDir, archived });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function maybeResetPiDurable(params: {
  readonly db: DatabaseSync;
  readonly sqliteDir: string;
  readonly maxBytes: number;
  readonly maxAgeSeconds: number;
  readonly current: DurableRuntime;
  readonly quiesce: () => Promise<void>;
  readonly markExpectedClose: (runtime: DurableRuntime) => void;
  readonly reopen: () => Promise<DurableRuntime>;
  readonly resumeUsers: () => void;
  readonly quiesceTimeoutMs: number;
  readonly context?: Context;
  readonly now?: () => number;
  readonly force?: PiDurableResetReason;
}) {
  const now = params.now ?? Date.now;
  const context = params.context ?? BACKGROUND_CONTEXT;
  const due = await piDurableResetDue({
    sqliteDir: params.sqliteDir,
    maxBytes: params.maxBytes,
    maxAgeSeconds: params.maxAgeSeconds,
    now: now(),
  });
  const reason = params.force ?? due.reason;
  if (reason === undefined) {
    return ((pinnedReturn: PiDurableResetOutcome) => pinnedReturn)({
      kind: "not_due",
      bytes: due.bytes,
      ageMs: due.ageMs,
    });
  }
  await params.quiesce();
  const deadline = Date.now() + params.quiesceTimeoutMs;
  let report = await verifyQuiescent({ db: params.db, runtime: params.current, context });
  while (!report.ok && Date.now() < deadline) {
    await delay(QUIESCENCE_POLL_MS);
    report = await verifyQuiescent({ db: params.db, runtime: params.current, context });
  }
  if (!report.ok) {
    params.resumeUsers();
    return ((pinnedReturn: PiDurableResetOutcome) => pinnedReturn)({
      kind: "not_quiescent",
      reason,
      detail: report,
    });
  }
  params.markExpectedClose(params.current);
  await params.current.handle.harness.close(context);
  await params.current.handle.closed;
  const { archiveDir, archived } = await archivePiDurableFiles(params.sqliteDir, now());
  const runtime = await params.reopen();
  runtime.handle.resume();
  params.resumeUsers();
  return ((pinnedReturn: PiDurableResetOutcome) => pinnedReturn)({
    kind: "reset",
    reason,
    archiveDir,
    archived,
    runtime,
  });
}
