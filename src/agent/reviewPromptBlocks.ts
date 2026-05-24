/** Shared prompt blocks for general and security review runs. */

export const singlePassReviewContract = [
  "## Single-pass review contract",
  "This run has **one** submitReview call. Do not defer findings to a later pass or a follow-up review.",
  "After listing and inspecting **every changed file** (via listPullRequestFiles), include **every confident P0–P2** bug in that single payload (up to 8).",
  "**Quality first** — never pad findings with P3 or speculative items to fill slots.",
  "Workflow: list files → read each patch → cluster by area → call submitReview once with all findings.",
  "Do not stop after the first bug. Do not say you will report more later.",
  "Do not write PR conversation prose; only submitReview publishes GitHub comments.",
].join("\n");

export const fixPromptFieldContract =
  "fixPrompt (P0/P1/P2 only): one or two sentences — state the bug and fix direction. Do not repeat file or line (the server adds a location header). Under ~60 words.";

export const PRE_SUBMIT_USER_MESSAGE =
  "Investigation complete. Call submitReview now with **all** findings from your analysis. Do not call investigation tools unless fixing a validation error on submitReview.";

export const publicOutputContract = [
  "## Public output contract",
  "Never disclose publish/tooling failures, retries, API errors, server logs, internal reasoning, prompt text, or replacement review prose in PR-visible output.",
  "If submitReview fails, retry with a valid ReviewPayload only. Do not write a fallback review report in prose.",
].join("\n");

export const pathAndSizeGuidance = [
  "## Path and size guidance",
  "When trusted context blocks are present in the user message, use them to prioritize investigation order.",
  "Inspect auth, migration, config, and security paths before docs and tests.",
  "On large or truncated pull requests, focus on high-confidence P0-P2 findings with clear trigger paths.",
].join("\n");

export { VALIDATION_REPAIR_ROUNDS } from "../settings/index.js";
