import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { Db } from "pg-boss";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import {
  POSTGRES_CONNECTION_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_IDLE_TIMEOUT_MS,
  POSTGRES_KEEPALIVE_INITIAL_DELAY_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_POOL_MAX,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../settings/index.js";

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

export function pgBossDb(client: PoolClient): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => client.query(text, values),
  };
}

export async function inTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let rollbackError: unknown;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      rollbackError = error;
      logWarn("postgres_rollback_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw e;
  } finally {
    client.release(rollbackError !== undefined ? true : undefined);
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result: QueryResult<T> = await client.query(text, values);
  return result.rows[0] ?? null;
}
