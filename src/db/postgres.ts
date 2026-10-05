import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { Db } from "pg-boss";
import {
  type Config,
  POSTGRES_CONNECTION_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_IDLE_TIMEOUT_MS,
  POSTGRES_KEEPALIVE_INITIAL_DELAY_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_POOL_MAX,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../settings/index.js";
import { logWarn } from "../evlog.js";
import { errorMessage } from "../errors/errorMessage.js";

export function createPgPool(cfg: Pick<Config, "runtime">): Pool {
  const pool = new Pool({
    connectionString: cfg.runtime.databaseUrl,
    max: POSTGRES_POOL_MAX,
    idleTimeoutMillis: POSTGRES_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: POSTGRES_KEEPALIVE_INITIAL_DELAY_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: `pr-agent-${cfg.runtime.role}`,
  });
  // A Postgres restart fails idle sockets, which reach the pool's "error" event;
  // without a listener that is an uncaught exception and the process exits.
  pool.on("error", (error) => {
    logWarn("postgres_idle_client_error", {
      code: "code" in error && typeof error.code === "string" ? error.code : undefined,
      message: error.message,
    });
  });
  // pg-pool detaches its idle "error" listener from checked-out clients, and a pg
  // Client always emits "error" on a socket failure. This listener only prevents
  // the crash; the failure still reaches the caller through its query.
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  return pool;
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
        message: errorMessage(error),
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
