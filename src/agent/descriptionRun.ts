import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../agentWork/localPrWorkspace.js";
import { runDescriptionHarness } from "./descriptionRunHarness.js";

export type DescriptionRunResult = {
  lastAssistant: AssistantMessage;
  published: boolean;
  publishSuperseded: boolean;
};

export async function runFullPrDescription(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  cwd?: string;
  workspace?: LocalPrWorkspace;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
}): Promise<DescriptionRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  return runDescriptionHarness(params);
}
