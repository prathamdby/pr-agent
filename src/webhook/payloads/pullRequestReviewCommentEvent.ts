import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestReviewCommentWebhookSchema = z
	.strictObject({
		action: z.string(),
		installation: installationSchema,
		repository: repositorySchema,
		pull_request: z.strictObject({
			number: z.number(),
		}),
		comment: z.strictObject({
			id: z.number(),
			user: z.strictObject({
				id: z.number(),
			}),
			body: z.string().nullish(),
		}),
	});

export type PullRequestReviewCommentWebhookPayload = z.infer<typeof pullRequestReviewCommentWebhookSchema>;
