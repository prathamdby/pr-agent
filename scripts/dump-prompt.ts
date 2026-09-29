import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.ts";
import {
  ORCHESTRATOR_RECON_INSTRUCTION,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
} from "../src/review/orchestrator/prompts/orchestratorPrompts.ts";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.ts";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.ts";
import { automatedSecuritySystemPrompt } from "../src/agent/prompts/securityPrompt.ts";

const persona = process.argv[2];
const prompts: Record<string, string> = {
  correctness: buildAutomatedSystemPrompt(),
  judgment: [orchestratorSystemPrompt, ORCHESTRATOR_RECON_INSTRUCTION].join("\n\n"),
  "judgment-turn": renderJudgmentTurn(
    {
      kind: "report",
      specialist: "correctness",
      report: { status: "no_findings", findings: [] },
      durationMs: 0,
    },
    {
      accepted: [],
      suppressionFingerprints: new Set(),
      inlineReviewIds: [],
      postedInlineCount: 0,
      threadCallCount: 0,
      threadBudgetExhausted: false,
    },
  ),
  security: automatedSecuritySystemPrompt,
  quality: automatedQualitySystemPrompt,
  tests: automatedReviewTestsSystemPrompt,
};

if (!persona || !(persona in prompts)) {
  console.error(`Usage: nub run dump-prompt <persona>  (${Object.keys(prompts).join(" | ")})`);
  process.exit(1);
}
console.log(prompts[persona]);
