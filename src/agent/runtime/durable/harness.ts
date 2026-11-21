import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { ConversationId, SessionEnd, TaskId } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { AppError } from "../../../errors/appError.ts";

export const PI_DURABLE_DB_FILENAME = "pi_durable.sqlite";
export const PI_DURABLE_EPOCH_FILENAME = "pi_durable.sqlite.created_at";
export const PI_DURABLE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const SQLITE_SYNCHRONOUS_FULL = 2;

export type OpenDurableHarnessParams = Pick<
  HarnessOptions,
  | "registry"
  | "env"
  | "models"
  | "telemetry"
  | "onReport"
  | "settings"
  | "conversationCreated"
  | "now"
> & {
  readonly sqliteDir: string;
  readonly context?: Context;
};

export type DurableHarnessHandle = {
  readonly harness: Harness;
  readonly resume: () => void;
  readonly closed: Promise<SessionEnd>;
  readonly storage: Storage;
  readonly synchronous?: number;
};

async function assertSynchronousFull(db: SqliteDatabase) {
  await db.exec("PRAGMA synchronous = FULL");
  const row = await db.get<{ synchronous: number }>("PRAGMA synchronous");
  if (row?.synchronous !== SQLITE_SYNCHRONOUS_FULL) {
    throw new AppError({
      domain: "runtime",
      kind: "storage_pragma_mismatch",
      message: `pi_durable.sqlite PRAGMA synchronous read back ${String(row?.synchronous)}, expected ${SQLITE_SYNCHRONOUS_FULL}.`,
      context: { pragma: "synchronous", value: row?.synchronous },
    });
  }
  return ((pinnedReturn: number) => pinnedReturn)(row.synchronous);
}

function isDurableIdNumber(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function durableIdNumber(text: string | null | undefined) {
  if (text === null || text === undefined || !/^\d+$/.test(text))
    return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  const value = Number(text);
  return ((pinnedReturn: number | undefined) => pinnedReturn)(
    isDurableIdNumber(value) ? value : undefined,
  );
}

function isConversationIdNumber(value: number): value is ConversationId {
  return isDurableIdNumber(value);
}

function isTaskIdNumber(value: number): value is TaskId {
  return isDurableIdNumber(value);
}

export function conversationIdFromText(text: string | null | undefined) {
  const value = durableIdNumber(text);
  return ((pinnedReturn: ConversationId | undefined) => pinnedReturn)(
    value !== undefined && isConversationIdNumber(value) ? value : undefined,
  );
}

export function taskIdFromText(text: string | null | undefined) {
  const value = durableIdNumber(text);
  return ((pinnedReturn: TaskId | undefined) => pinnedReturn)(
    value !== undefined && isTaskIdNumber(value) ? value : undefined,
  );
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function piDurableCreatedAt(sqliteDir: string, now = Date.now()) {
  const marker = join(sqliteDir, PI_DURABLE_EPOCH_FILENAME);
  try {
    const parsed = Number((await readFile(marker, "utf8")).trim());
    if (Number.isFinite(parsed) && parsed > 0)
      return ((pinnedReturn: number) => pinnedReturn)(parsed);
  } catch {}
  await writeFile(marker, String(now));
  return ((pinnedReturn: number) => pinnedReturn)(now);
}

export async function openDurableHarness(params: OpenDurableHarnessParams) {
  await mkdir(params.sqliteDir, { recursive: true });
  if (!(await fileExists(join(params.sqliteDir, PI_DURABLE_DB_FILENAME)))) {
    await writeFile(join(params.sqliteDir, PI_DURABLE_EPOCH_FILENAME), String(Date.now()));
  }
  const db = await openNodeSqliteDatabase(join(params.sqliteDir, PI_DURABLE_DB_FILENAME));
  let synchronous: number;
  try {
    synchronous = await assertSynchronousFull(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  const storage = await SqliteStorage.open(db);
  const options: HarnessOptions = {
    registry: params.registry,
    models: params.models,
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.telemetry !== undefined ? { telemetry: params.telemetry } : {}),
    ...(params.onReport !== undefined ? { onReport: params.onReport } : {}),
    ...(params.settings !== undefined ? { settings: params.settings } : {}),
    ...(params.conversationCreated !== undefined
      ? { conversationCreated: params.conversationCreated }
      : {}),
    ...(params.now !== undefined ? { now: params.now } : {}),
  };
  const context = params.context ?? BACKGROUND_CONTEXT;
  try {
    const harness = await Harness.open(storage, options, context);
    return ((pinnedReturn: DurableHarnessHandle | Promise<DurableHarnessHandle>) => pinnedReturn)({
      harness,
      resume: () => harness.resume(),
      closed: harness.closed,
      storage,
      synchronous,
    });
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT).catch(() => {});
    await db.close().catch(() => {});
    throw error;
  }
}
