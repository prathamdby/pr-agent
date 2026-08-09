import * as v from "valibot";

export const installationSchema = v.object({
  id: v.number(),
});

export const repositorySchema = v.object({
  owner: v.object({ login: v.string() }),
  name: v.string(),
  size: v.optional(v.number()),
});

/** GitHub App webhooks include `installation`; use loose top-level object so extra fields are allowed. */
export const installationIdPickSchema = v.object({
  installation: installationSchema,
});
