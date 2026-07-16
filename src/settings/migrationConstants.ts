/** Database migrations path (relative to process cwd). */
export const MIGRATIONS_DIR_NAME = "migrations";

/** Stable key for the pg_advisory_lock that serializes runMigrations across processes. */
export const MIGRATION_ADVISORY_LOCK_KEY = 4_785_219;
