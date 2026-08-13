import { Pool, type QueryResultRow } from "pg";
import type { Db } from "pg-boss";
import * as v from "valibot";
import type { Config } from "../config.js";
import {
  POSTGRES_CONNECTION_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_IDLE_TIMEOUT_MS,
  POSTGRES_KEEPALIVE_INITIAL_DELAY_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_POOL_MAX,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../settings/index.js";
import { jsonValueSchema, type JsonValue } from "../util/jsonValue.js";

export type IntakeQueryResult<T extends QueryResultRow = QueryResultRow> = {
  readonly rows: T[];
  readonly rowCount?: number | null;
};

/** Values `pg` accepts on parameterized queries used at intake. */
export type IntakeQueryValue = JsonValue | Date | Buffer;

/** Query surface used at intake. Real `Pool` and `PoolClient` are assignable. */
export type IntakeClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly IntakeQueryValue[],
  ): Promise<IntakeQueryResult<T>>;
};

/** Client returned by `IntakePool.connect()`. Real `PoolClient` is assignable. */
export type IntakeConnectedClient = IntakeClient & {
  release(err?: boolean | Error): void;
};

/**
 * Pool surface used at webhook intake: `connect` for transactions, `query` for
 * ping and ignored-webhook inserts. Real `Pool` is assignable.
 */
export type IntakePool = IntakeClient & {
  connect(): Promise<IntakeConnectedClient>;
};

export function createPgPool(cfg: Pick<Config, "databaseUrl" | "role">): Pool {
  return new Pool({
    connectionString: cfg.databaseUrl,
    max: POSTGRES_POOL_MAX,
    idleTimeoutMillis: POSTGRES_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: POSTGRES_KEEPALIVE_INITIAL_DELAY_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: `pr-agent-${cfg.role}`,
  });
}

export function pgBossDb(client: IntakeClient): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      const parsed = v.parse(v.optional(v.array(jsonValueSchema)), values);
      return client.query(text, parsed);
    },
  };
}

export async function inTransaction<T>(
  pool: IntakePool,
  fn: (client: IntakeClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: IntakeClient,
  text: string,
  values: readonly IntakeQueryValue[] = [],
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  return result.rows[0] ?? null;
}
