export const GITHUB_INT32_ID_MAX = 2_147_483_647;

export const GITHUB_SAFE_ID_MAX = Number.MAX_SAFE_INTEGER;

export const GITHUB_LOGIN_MAX_CHARS = 39;

export const GITHUB_REPO_NAME_MAX_CHARS = 100;

export const GITHUB_SHA_MAX_CHARS = 64;

export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 3;

export const SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS = 60_000;

export const GITHUB_REACTION_EYES = "eyes" as const;
export const GITHUB_REACTION_PLUS_ONE = "+1" as const;
export const GITHUB_REACTION_MINUS_ONE = "-1" as const;

export type GithubReactionContent =
  | typeof GITHUB_REACTION_EYES
  | typeof GITHUB_REACTION_PLUS_ONE
  | typeof GITHUB_REACTION_MINUS_ONE;
