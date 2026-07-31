export const TOKEN_FRESHNESS_BUFFER_MS = 60_000;
export const REVIEW_FINALIZATION_WINDOW_MS = 30_000;
export const INSTALLATION_TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000;

export const POSTGRES_POOL_MAX = 10;
/** pg-boss pool size for ROLE=web (enqueue + LISTEN only; maintenance off). */
export const PG_BOSS_POOL_MAX_WEB = 4;
/** pg-boss pool size for ROLE=worker (consumers + maintenance); below node-pg default 10. */
export const PG_BOSS_POOL_MAX_WORKER = 8;
export const POSTGRES_IDLE_TIMEOUT_MS = 30_000;
export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;
export const POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;
export const POSTGRES_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
export const POSTGRES_LOCK_TIMEOUT_MS = 10_000;
export const POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
export const GITHUB_WEBHOOK_RESPONSE_MARGIN_MS = 2_000;

/** Wall-clock budget (ms) for the /ready Postgres ping. */
export const HEALTH_DB_PING_TIMEOUT_MS = 2_000;
