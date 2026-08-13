import type { QueryResultRow } from "pg";
import type {
  IntakeClient,
  IntakeConnectedClient,
  IntakePool,
  IntakeQueryValue,
} from "../../src/db/postgres.js";

type TestQuery = {
  bivarianceHack(
    sql: string,
    values?: readonly IntakeQueryValue[],
  ): Promise<{ readonly rows: QueryResultRow[]; readonly rowCount?: number | null }>;
}["bivarianceHack"];

class FakeIntakeClient implements IntakeConnectedClient {
  readonly query: IntakeClient["query"];

  constructor(impl: TestQuery) {
    // SAFETY: test query doubles are not generic; production mappers parse row shapes.
    this.query = impl as IntakeClient["query"];
  }

  release(_err?: boolean | Error): void {}
}

function poolFromQuery(impl: TestQuery, connectable: boolean): IntakePool {
  const client = new FakeIntakeClient(impl);
  return {
    query: (queryText, values) => client.query(queryText, values),
    connect: async () => {
      if (!connectable) {
        throw new Error("test pool: stub inTransaction instead of connect");
      }
      return client;
    },
  };
}

export function createUnusedPool(): IntakePool {
  return poolFromQuery(async () => {
    throw new Error("test pool: stub inTransaction instead of query");
  }, false);
}

export function createQueryClient(query: TestQuery): IntakeClient {
  return new FakeIntakeClient(query);
}

export function createQueryPool(query: TestQuery): IntakePool {
  return poolFromQuery(query, true);
}
