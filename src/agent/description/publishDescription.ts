import type { Config } from "../../config.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { DescriptionPayload } from "./descriptionSchema.js";

export type PublishDescriptionResult = {
  readonly prNumber: number;
  readonly titleUpdated: boolean;
  readonly bodyUpdated: boolean;
};

export async function publishDescriptionToPullRequest(params: {
  cfg: Config;
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  payload: DescriptionPayload;
  operationMarker?: string;
}): Promise<PublishDescriptionResult> {
  const { cfg, prSurface, payload, operationMarker } = params;
  return prSurface.publishDescription(cfg, payload, operationMarker);
}
