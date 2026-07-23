import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
import type { VerificationPayload } from "../../review/triageSchema.js";
import { runVerificationHarness } from "./verificationRunHarness.js";

export type VerificationRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly submitted: boolean;
  readonly payload: VerificationPayload | null;
};

export async function runVerification(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly rootDir: string;
  readonly inventory: readonly BotFindingThread[];
  readonly pushedCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly durability?: FeatureSessionDurability;
}): Promise<VerificationRunResult> {
  return runVerificationHarness(params);
}
