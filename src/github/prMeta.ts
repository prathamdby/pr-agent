import { installationOctokit } from "./appAuth.js";

export async function getPullRequestHeadSha(apiToken: string, owner: string, repo: string, prNumber: number) {
	const o = installationOctokit(apiToken);
	const { data } = await o.rest.pulls.get({
		owner,
		repo,
		pull_number: prNumber,
	});
	return data.head.sha;
}
