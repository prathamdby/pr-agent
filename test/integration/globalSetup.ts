import { assertIntegrationDatabaseReady } from "./requireDatabase.js";

export default async function globalSetup(): Promise<void> {
  await assertIntegrationDatabaseReady();
}
