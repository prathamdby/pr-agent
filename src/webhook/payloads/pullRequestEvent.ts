import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestWebhookSchema = z
	.strictObject({
		action: z.string(),
		installation: installationSchema,
		repository: repositorySchema,
		pull_request: z.strictObject({
			number: z.number(),
			head: z.strictObject({
				sha: z.string(),
			}),
		}),
	});

export type PullRequestWebhookPayload = z.infer<typeof pullRequestWebhookSchema>;
