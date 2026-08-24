import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TriageScope } from "../../agentWork/types.js";
import type { Config } from "../../config.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { TriagePayload } from "../../review/triageSchema.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import type { FeatureSessionDurability } from "../runtime/sessionDurability.js";
import { runTriageHarness } from "./triageRunHarness.js";

export type TriageRunResult = {
  readonly lastAssistant: AssistantMessage;
  readonly submitted: boolean;
  readonly payload: TriagePayload | null;
  readonly commitByThreadRootCommentId: ReadonlyMap<number, string>;
};

export async function runFullPrTriage(params: {
  readonly cfg: Config;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly cwd?: string;
  readonly scope?: TriageScope;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly durability?: FeatureSessionDurability;
}): Promise<TriageRunResult> {
  return runTriageHarness(params);
}
