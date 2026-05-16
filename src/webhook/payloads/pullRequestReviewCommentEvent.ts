import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestReviewCommentWebhookSchema = z
	.object({
		action: z.string(),
		installation: installationSchema,
		repository: repositorySchema,
		pull_request: z.object({
			number: z.number(),
		}),
		comment: z.object({
			id: z.number(),
			user: z.object({
				id: z.number(),
			}),
			body: z.string().nullish(),
		}),
	});

export type PullRequestReviewCommentWebhookPayload = z.infer<typeof pullRequestReviewCommentWebhookSchema>;
