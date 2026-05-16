import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bridgeGithubToolsToPi } from "../src/bridge/aiSdkToolsToPiTools.js";

describe("bridgeGithubToolsToPi", () => {
	it("preserves AI SDK input schemas for nested review comments", () => {
		const { piTools } = bridgeGithubToolsToPi({
			createPullRequestReview: {
				description: "Submit a pull request review with inline comments",
				inputSchema: z.object({
					owner: z.string(),
					repo: z.string(),
					pullNumber: z.number(),
					event: z.enum(["REQUEST_CHANGES", "COMMENT"]),
					comments: z
						.array(
							z.object({
								path: z.string(),
								body: z.string(),
								line: z.number().optional(),
								side: z.enum(["LEFT", "RIGHT"]).optional(),
							}),
						)
						.optional(),
				}),
				execute: async () => ({ ok: true }),
			},
		});

		const reviewTool = piTools.find((tool) => tool.name === "createPullRequestReview");
		expect(reviewTool).toBeDefined();
		expect(reviewTool?.parameters).toMatchObject({
			type: "object",
			properties: {
				comments: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
							line: { type: "number" },
							side: { enum: ["LEFT", "RIGHT"] },
						},
					},
				},
			},
		});
	});
});
