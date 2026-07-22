import { automatedQualitySystemPrompt } from "../../../agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../../../agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../../../agent/prompts/securityPrompt.js";
import { buildAutomatedSystemPrompt } from "../../prompts/reviewSystemPrompt.js";
import type { SpecialistId } from "../orchestratorTypes.js";

const SPECIALIST_SYSTEM_PROMPTS = {
  correctness: buildAutomatedSystemPrompt(),
  security: automatedSecuritySystemPrompt,
  quality: automatedQualitySystemPrompt,
  tests: automatedReviewTestsSystemPrompt,
} satisfies Readonly<Record<SpecialistId, string>>;

export function specialistSystemPrompt(id: SpecialistId): string {
  return SPECIALIST_SYSTEM_PROMPTS[id];
}
