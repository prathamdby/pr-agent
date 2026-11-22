import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as v from "valibot";
import { AppError } from "../errors/appError.ts";

export const APP_STATE_DB_FILENAME = "app_state.sqlite";
const LOCK_DB_FILENAME = "pr-agent.lock.sqlite";
const SQLITE_SYNCHRONOUS_FULL = 2;

export type AppStateHandle = {
  readonly db: DatabaseSync;
  readonly lock: DatabaseSync;
  readonly path: string;
  readonly close: () => void;
};

function stateError(
  kind: "sqlite_writer_lock_held" | "sqlite_pragma_mismatch",
  message: string,
  context: Record<string, unknown>,
) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({ domain: "state", kind, message, context }),
  );
}

function pragmaInteger(db: DatabaseSync, name: string) {
  const row = v.parse(v.looseObject({}), db.prepare(`PRAGMA ${name}`).get());
  const value = row[name];
  return typeof value === "number" ? value : Number(value);
}

export function acquireSingleWriterLock(sqliteDir: string) {
  const lockPath = join(sqliteDir, LOCK_DB_FILENAME);
  const lock = new DatabaseSync(lockPath);
  lock.exec("PRAGMA journal_mode = WAL");
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw stateError(
      "sqlite_writer_lock_held",
      `Another pr-agent process holds the SQLite writer lock at ${lockPath}.`,
      { path: lockPath },
    );
  }
  return ((pinnedReturn: { readonly db: DatabaseSync; readonly path: string }) => pinnedReturn)({
    db: lock,
    path: lockPath,
  });
}

export function openAppState(params: {
  readonly sqliteDir: string;
  readonly dbPath?: string;
  readonly applySchema: (db: DatabaseSync) => void;
}) {
  mkdirSync(params.sqliteDir, { recursive: true });
  const path = resolve(params.dbPath ?? join(params.sqliteDir, APP_STATE_DB_FILENAME));
  const file = lstatSync(path, { throwIfNoEntry: false });
  const name = basename(path).toLowerCase();
  if (
    realpathSync(dirname(path)) !== realpathSync(params.sqliteDir) ||
    (file && (!file.isFile() || file.nlink !== 1)) ||
    [LOCK_DB_FILENAME, "pi_durable.sqlite"].some(
      (reserved) =>
        name === reserved || name.startsWith(reserved + "-") || name.startsWith(reserved + "."),
    )
  ) {
    throw new Error(
      "The app database must be a regular file directly inside SQLITE_DIR, not a link or runtime database.",
    );
  }
  const lock = acquireSingleWriterLock(params.sqliteDir);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    lock.db.close();
    throw error;
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (pragmaInteger(db, "synchronous") !== SQLITE_SYNCHRONOUS_FULL) {
      throw stateError(
        "sqlite_pragma_mismatch",
        `app_state.sqlite PRAGMA synchronous read back ${String(pragmaInteger(db, "synchronous"))}, expected ${SQLITE_SYNCHRONOUS_FULL}.`,
        { path, pragma: "synchronous" },
      );
    }
    params.applySchema(db);
  } catch (error) {
    db.close();
    lock.db.exec("ROLLBACK");
    lock.db.close();
    throw error;
  }
  let closed = false;
  return ((pinnedReturn: AppStateHandle) => pinnedReturn)({
    db,
    lock: lock.db,
    path,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
      lock.db.exec("ROLLBACK");
      lock.db.close();
    },
  });
}

export function readRow<S extends v.GenericSchema>(raw: unknown, schema: S) {
  if (raw === undefined || raw === null) {
    return ((pinnedReturn: v.InferOutput<S> | undefined) => pinnedReturn)(undefined);
  }
  return ((pinnedReturn: v.InferOutput<S> | undefined) => pinnedReturn)(v.parse(schema, raw));
}

export function readRows<S extends v.GenericSchema>(raw: unknown, schema: S) {
  return ((pinnedReturn: v.InferOutput<S>[]) => pinnedReturn)(v.parse(v.array(schema), raw));
}

export function immediate<T>(db: DatabaseSync, fn: () => T) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return ((pinnedReturn: T) => pinnedReturn)(result);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
