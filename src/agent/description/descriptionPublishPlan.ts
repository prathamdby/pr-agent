import type { PrResource } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import type { PullRequestForFileList } from "../../github/listPullRequestFiles.js";
import { mergeDescriptionIntoPrBody } from "./descriptionBodyMerge.js";
import { renderDescriptionAgentBlock } from "./descriptionRender.js";
import type { DescriptionPayload } from "./descriptionSchema.js";

export type DescriptionPublishPlan = {
  readonly title: string;
  readonly body: string;
  readonly titleUpdated: boolean;
  readonly bodyUpdated: boolean;
};

/**
 * Merge the generated block into the live pull request. The caller writes only
 * when a field changes, so a replay over an already-merged body sends nothing.
 */
export function planDescriptionPublish(params: {
  readonly cfg: Pick<Config, "features">;
  readonly pullRequest: Pick<PullRequestForFileList, "title" | "body">;
  readonly resource: PrResource;
  readonly payload: DescriptionPayload;
  readonly operationMarker?: string;
}): DescriptionPublishPlan {
  const { pullRequest, payload, operationMarker } = params;
  const agentBlock = renderDescriptionAgentBlock(payload, params.resource);
  const body = mergeDescriptionIntoPrBody({
    currentBody: pullRequest.body,
    agentBlock: operationMarker == null ? agentBlock : `${agentBlock}\n${operationMarker}`,
  });
  const currentTitle = pullRequest.title ?? "";
  const titleRewrite = params.cfg.features.titleRewrite;
  const title = titleRewrite ? payload.title.trim() : currentTitle;
  return {
    title,
    body,
    titleUpdated: titleRewrite && title !== currentTitle,
    bodyUpdated: body !== (pullRequest.body ?? ""),
  };
}
