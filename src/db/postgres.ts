import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { Db } from "pg-boss";
import type { Config } from "../config.js";

export type DbPool = Pool;

export function createPgPool(cfg: Pick<Config, "databaseUrl">): Pool {
	return new Pool({ connectionString: cfg.databaseUrl, max: 10 });
}

export function pgBossDb(client: PoolClient): Db {
	return {
		executeSql: async (text: string, values?: unknown[]) => client.query(text, values),
	};
}

export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
	client: Pool | PoolClient,
	text: string,
	values: unknown[] = [],
): Promise<T | null> {
	const result: QueryResult<T> = await client.query(text, values);
	return result.rows[0] ?? null;
}

