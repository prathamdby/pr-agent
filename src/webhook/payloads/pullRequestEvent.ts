import * as v from "valibot";
import {
  githubPrNumberSchema,
  githubShaSchema,
  githubUserSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";

const lifecycleTimestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(
    (value) =>
      value.endsWith("Z") &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    "Expected a valid UTC lifecycle timestamp",
  ),
);

export const pullRequestWebhookSchema = v.pipe(
  v.object({
    action: v.string(),
    installation: installationSchema,
    repository: repositorySchema,
    before: v.optional(githubShaSchema),
    pull_request: v.object({
      number: githubPrNumberSchema,
      head: v.object({
        sha: githubShaSchema,
      }),
      merged: v.optional(v.boolean(), false),
      user: v.nullish(v.object({ ...githubUserSchema.entries, type: v.nullish(v.string()) })),
      author_association: v.nullish(v.string()),
      state: v.optional(v.picklist(["open", "closed"])),
      updated_at: v.optional(lifecycleTimestampSchema),
    }),
  }),
  v.check((data) => {
    if (data.action !== "closed" && data.action !== "reopened") return true;
    const pr = data.pull_request;
    return (
      pr.updated_at != null &&
      (data.action === "closed" ? pr.state === "closed" : pr.state === "open" && !pr.merged)
    );
  }, "Close and reopen require consistent lifecycle state and observation time"),
);

export type PullRequestWebhookPayload = v.InferOutput<typeof pullRequestWebhookSchema>;
