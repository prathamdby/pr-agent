import { ste100WritingGuidance } from "../../../agent/prompts/ste100Guidance.js";
import {
  technicalDepthRule,
  type DescriptionWritingPolicy,
} from "../../../agent/description/descriptionWritingPolicy.js";

/**
 * System-prompt contract for ReviewPayload overview fields (Note + security row).
 * Scale hard rules are injected per synthesis turn from workspace size stats.
 */
export const reviewOverviewWritingGuidance = [
  ste100WritingGuidance,
  "",
  "## Review overview (prCharacter)",
  "",
  "The Note on the review summary is `prCharacter`. It is the only free-form overview for maintainers.",
  "The server chooses overview scale from workspace size stats and injects a hard rule in the synthesis turn.",
  "Follow that rule for sentence or bullet count, words per sentence, and technical depth.",
  "",
  "### Always do",
  "- State the product change and the main review stakes in plain STE100 sentences.",
  "- Prefer a short bullet list when three or more distinct themes appear.",
  "- Match depth to the hard rule (what_why | what_why_risk | what_why_how).",
  "",
  "### Never do",
  "- Do not inventory every changed file or restate the findings table.",
  "- Do not report specialist lane status, tool names, retries, or internal run process.",
  "- Do not dump implementation history or a file-by-file walkthrough.",
  "- Do not pad with empty or repeated sentences when the hard rule asks for fewer.",
  "",
  "### Other overview fields",
  "- securityConcerns: null when none; otherwise one or two short STE100 sentences naming the risk.",
  "- size: XS | S | M | L | XL | XXL for the scale of the change set, not code quality.",
  "- relevantTests: yes | no | partial from the accepted evidence only.",
  "- followUps: short STE100 lines for deferred non-blocking work; empty when none.",
  "- judgmentCalls: 0–3 product or architecture decisions a human must make. Not bugs. Empty when the change is mechanical.",
  "- Never write merge, approve, or safe-to-merge wording in any overview field.",
].join("\n");

export function formatOverviewWritingHardRule(policy: DescriptionWritingPolicy): string {
  return [
    `Hard rule (overview scale: ${policy.bodyScale}):`,
    `Write prCharacter as ${policy.bulletMin}–${policy.bulletMax} short sentences or markdown bullets.`,
    `Each sentence is at most ${policy.maxWordsPerBullet} words.`,
    technicalDepthRule(policy.technicalDepth),
    "Use ASD-STE100 active voice and simple tense.",
    "Do not restate findings, specialist lanes, or tool process.",
    "Ground every claim in the accepted placements and the reviewed checkout.",
  ].join(" ");
}
