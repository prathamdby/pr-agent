import { assertIntegrationDatabaseReady } from "./requireDatabase.ts";

export default async function globalSetup(): Promise<void> {
  await assertIntegrationDatabaseReady();
}
