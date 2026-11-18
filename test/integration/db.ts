import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

export const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

export function integrationPool() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
  return ((pinnedReturn: Pool) => pinnedReturn)(
    new Pool({ connectionString: DATABASE_URL, max: 4 }),
  );
}
