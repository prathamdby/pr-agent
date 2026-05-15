import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const issueCommentWebhookSchema = z
	.strictObject({
		action: z.string(),
		installation: installationSchema,
		repository: repositorySchema,
		issue: z
			.strictObject({
				number: z.number(),
				pull_request: z.unknown(),
			})
			.refine((i) => i.pull_request != null, { message: "issue must belong to a pull request" }),
		comment: z.strictObject({
			id: z.number(),
			user: z.strictObject({
				id: z.number(),
			}),
			body: z.string().nullish(),
		}),
	});

export type IssueCommentWebhookPayload = z.infer<typeof issueCommentWebhookSchema>;
