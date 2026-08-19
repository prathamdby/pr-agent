/** GitHub API / token handling. */

/** Postgres `integer` bound for pull request numbers. */
export const GITHUB_INT32_ID_MAX = 2_147_483_647;

/** JS-safe positive bound for installation, comment, and user ids stored as bigint or JSON. */
export const GITHUB_SAFE_ID_MAX = Number.MAX_SAFE_INTEGER;

/** GitHub user/org login max length. */
export const GITHUB_LOGIN_MAX_CHARS = 39;

/** GitHub repository name max length. */
export const GITHUB_REPO_NAME_MAX_CHARS = 100;

/** Git object id max length (SHA-1 or SHA-256 hex). */
export const GITHUB_SHA_MAX_CHARS = 64;

export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 3;

/** Shared Postgres installation circuit cooldown after local rate-limit exhaust. */
export const SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS = 60_000;

export const GITHUB_REACTION_EYES = "eyes" as const;
export const GITHUB_REACTION_PLUS_ONE = "+1" as const;
export const GITHUB_REACTION_MINUS_ONE = "-1" as const;

export type GithubReactionContent =
  | typeof GITHUB_REACTION_EYES
  | typeof GITHUB_REACTION_PLUS_ONE
  | typeof GITHUB_REACTION_MINUS_ONE;
