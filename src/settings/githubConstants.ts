/** GitHub API / token handling. */
export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 3;

export const GITHUB_REACTION_EYES = "eyes" as const;
export const GITHUB_REACTION_PLUS_ONE = "+1" as const;
export const GITHUB_REACTION_MINUS_ONE = "-1" as const;

export type GithubReactionContent =
  | typeof GITHUB_REACTION_EYES
  | typeof GITHUB_REACTION_PLUS_ONE
  | typeof GITHUB_REACTION_MINUS_ONE;
