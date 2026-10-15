import type { BoundPolicyJudgePair } from "../../review/publish/boundPolicyJudge.js";
import { noToolsTurnGuidance } from "../shared/output.js";
import { wrapUntrustedBlock } from "../shared/safety.js";

export const BOUND_POLICY_JUDGE_SYSTEM_PROMPT = [
  "You judge whether a review finding violates a bound same-repo repo policy rule.",
  noToolsTurnGuidance,
  "A yes attaches the rule's path to a published review thread as the policy the finding breaks, so it needs to hold up when a maintainer opens the rule.",
  "Each asked pair is self-contained: one finding and one always-apply rule. Most findings do not violate a given rule.",
  'The reply is {"yes":["p0"]}, listing only ids from the asked list.',
  "An id belongs in yes when the finding's own text and snippet show it breaks that pair's rule. When the evidence leaves the violation unclear, the id stays out; the finding still publishes without a policy path.",
].join("\n");

export function buildBoundPolicyJudgeUserMessage(pairs: readonly BoundPolicyJudgePair[]): string {
  const asked = pairs.map((pair) => pair.id).join(", ");
  const blocks = pairs.map((pair) => {
    const findingLines = [
      `id: ${pair.id}`,
      `file: ${pair.file}`,
      `lines: ${pair.startLine}-${pair.endLine}`,
      `severity: ${pair.severity}`,
      `title: ${pair.title}`,
      `detail: ${pair.detail}`,
      ...(pair.snippet ? [`snippet: ${pair.snippet}`] : []),
    ].join("\n");
    return [
      `Pair ${pair.id}`,
      `Rule \`${pair.relativePath}\`: ${pair.body}`,
      wrapUntrustedBlock("bound_policy_finding", findingLines),
    ].join("\n");
  });
  return [`Asked ids: ${asked}`, "", ...blocks].join("\n");
}
