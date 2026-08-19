import * as v from "valibot";
import {
  GITHUB_INT32_ID_MAX,
  GITHUB_LOGIN_MAX_CHARS,
  GITHUB_REPO_NAME_MAX_CHARS,
  GITHUB_SAFE_ID_MAX,
  GITHUB_SHA_MAX_CHARS,
} from "../../settings/index.js";

/** PR numbers persisted on `agent_work_items.pr_number` (Postgres integer). */
export const githubPrNumberSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(GITHUB_INT32_ID_MAX),
);

/** Installation, comment, user, and Actions ids (JS-safe positive integers). */
export const githubSafeIdSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(GITHUB_SAFE_ID_MAX),
);

export const githubLoginSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(GITHUB_LOGIN_MAX_CHARS),
);

export const githubRepoNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(GITHUB_REPO_NAME_MAX_CHARS),
);

export const githubShaSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(GITHUB_SHA_MAX_CHARS),
);

export const githubUserSchema = v.object({
  id: githubSafeIdSchema,
  login: v.nullish(githubLoginSchema),
});

export const installationSchema = v.object({
  id: githubSafeIdSchema,
});

export const repositorySchema = v.object({
  owner: v.object({ login: githubLoginSchema }),
  name: githubRepoNameSchema,
  size: v.optional(v.number()),
});

/** GitHub App webhooks include `installation`; use loose top-level object so extra fields are allowed. */
export const installationIdPickSchema = v.object({
  installation: installationSchema,
});
