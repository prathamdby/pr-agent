import { createGithubTools } from "@github-tools/sdk";
import type { GithubTools } from "@github-tools/sdk";

export function buildCodeReviewToolset(token: string): GithubTools {
	return createGithubTools({
		token,
		preset: "code-review",
		requireApproval: false,
	});
}
