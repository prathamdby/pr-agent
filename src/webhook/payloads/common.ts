import { z } from "zod";

export const installationSchema = z.object({
  id: z.number(),
});

export const repositorySchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

/** GitHub App webhooks include `installation`; use loose top-level object so extra fields are allowed. */
export const installationIdPickSchema = z.object({
  installation: installationSchema,
});

export type InstallationIdPick = z.infer<typeof installationIdPickSchema>;
export type RepositoryShape = z.infer<typeof repositorySchema>;
