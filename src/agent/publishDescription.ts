import type { Config } from "../config.js";
import { installationOctokit } from "../github/appAuth.js";
import { mergeDescriptionIntoPrBody } from "./descriptionBodyMerge.js";
import { renderDescriptionAgentBlock } from "./descriptionRender.js";
import type { DescriptionPayload } from "./descriptionSchema.js";

export type PublishDescriptionResult = {
  readonly prNumber: number;
  readonly titleUpdated: boolean;
  readonly bodyUpdated: boolean;
};

export async function publishDescriptionToPullRequest(params: {
  cfg: Config;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  payload: DescriptionPayload;
}): Promise<PublishDescriptionResult> {
  const { cfg, token, owner, repo, prNumber, payload } = params;
  const octokit = installationOctokit(token);
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const agentBlock = renderDescriptionAgentBlock(payload, {
    owner,
    repo,
    prNumber,
  });
  const mergedBody = mergeDescriptionIntoPrBody({
    currentBody: pr.body,
    agentBlock,
  });

  const nextTitle = cfg.descriptionGenerateTitle ? payload.title.trim() : (pr.title ?? "");
  const titleUpdated = cfg.descriptionGenerateTitle && nextTitle !== (pr.title ?? "");
  const bodyUpdated = mergedBody !== (pr.body ?? "");

  if (titleUpdated || bodyUpdated) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      title: nextTitle,
      body: mergedBody,
    });
  }

  return { prNumber, titleUpdated, bodyUpdated };
}
