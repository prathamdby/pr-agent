/** Test-only pure string transforms — do not import from production paths. */

export type PromptCostCandidateId =
  | "baseline"
  | "compact-static"
  | "compact-tool-result"
  | "custom-shorthand";

export type PromptCostTransform = {
  readonly id: PromptCostCandidateId;
  readonly description: string;
  readonly apply: (text: string) => string;
};

/** Identity: production prompt surface as built today. */
export const baselineTransform: PromptCostTransform = {
  id: "baseline",
  description: "Unmodified production prompt surface",
  apply: (text) => text,
};

/** Collapse excess blank lines and trailing whitespace only. */
export function compactStaticFormatting(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export const compactStaticTransform: PromptCostTransform = {
  id: "compact-static",
  description: "Collapse excess blank lines and trailing whitespace",
  apply: compactStaticFormatting,
};

/** Shorten truncated-tool markers and multi-space padding; keep field names. */
export function compactToolResultFormatting(text: string): string {
  let out = compactStaticFormatting(text);
  out = out.replace(
    /<!--\s*tool_result\s+truncated="true"\s+reason="response byte budget exceeded"\s*-->/g,
    "<!--tool_result truncated=true reason=byte_budget-->",
  );
  out = out.replace(
    /"truncationReason"\s*:\s*"response byte budget exceeded"/g,
    '"truncationReason":"byte_budget"',
  );
  out = out.replace(/ {2,}/g, " ");
  return out;
}

export const compactToolResultTransform: PromptCostTransform = {
  id: "compact-tool-result",
  description: "Shorten truncated-tool markers and multi-space padding",
  apply: compactToolResultFormatting,
};

/**
 * Test-only shorthand: compress non-contract headers/phrases only.
 * Required markers stay intact; lossyStripTransform is the negative control.
 */
const SHORTHAND_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/## High-signal bug patterns/g, "## HSBP"],
  [/## Evidence bar and anti-slop discipline/g, "## Anti-slop"],
  [/## High-stakes \/ trivial-change trap/g, "## HST"],
  [/## Security tripwires/g, "## SecTrip"],
  [/## Prose contracts/g, "## Prose"],
  [/## Prior inline review feedback/g, "## PriorFB"],
  [/## Single-pass review contract/g, "## 1pass"],
  [/## Structured delivery \(submitReview\)/g, "## SD(submitReview)"],
  [/## Public output contract/g, "## POC"],
  [/## Path and size guidance/g, "## PathSize"],
  [/## Investigation protocol \(local workspace tools\)/g, "## InvProto"],
  [/## Code-quality mission/g, "## CQ"],
  [/## Test-drafting mission/g, "## TDM"],
  [/## Known vulnerability categories/g, "## VulnCats"],
  [/## Rule out mitigations before flagging/g, "## MitigateFirst"],
  [/## Subtle auth-bypass patterns/g, "## AuthBypass"],
  [/## Out-of-scope files/g, "## OOS"],
  [/## Severity classification \(security findings only\)/g, "## Sev(sec)"],
  [/## Severity classification \(test-gap findings only\)/g, "## Sev(tests)"],
  [/## What to review/g, "## Scope"],
  [/## Prove it before you flag it/g, "## Prove"],
  [/## Reporting gate/g, "## Gate"],
  [/## What earns a finding/g, "## Earns"],
  [/## Preferred remedies \(carry these in fixPrompt\)/g, "## Remedies"],
  [/## What to look for/g, "## LookFor"],
  [/\bDo not report\b/g, "DNR"],
  [/\bNever report\b/g, "NR"],
  [/\bStatic analysis only\b/g, "SAO"],
  [/\bresponse byte budget exceeded\b/g, "byte budget exceeded"],
];

export function customShorthandPrototype(text: string): string {
  let out = compactStaticFormatting(text);
  for (const [pattern, replacement] of SHORTHAND_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export const customShorthandTransform: PromptCostTransform = {
  id: "custom-shorthand",
  description: "Test-only header/prose shorthand (experimental, not for production)",
  apply: customShorthandPrototype,
};

/** Negative-control transform that strips contract markers and evidence labels. */
export function lossyStripContractMarkers(text: string): string {
  return text
    .replace(/submitReview exactly once/g, "")
    .replace(/\bP0\b/g, "")
    .replace(/\bP1\b/g, "")
    .replace(/\bP2\b/g, "")
    .replace(/\bP3\b/g, "")
    .replace(/\bprCharacter\b/g, "")
    .replace(/\bfindings\b/g, "")
    .replace(/\bestimatedEffort\b/g, "")
    .replace(/\brelevantTests\b/g, "")
    .replace(/\bsecurityConcerns\b/g, "")
    .replace(/\bfollowUps\b/g, "")
    .replace(/\bReviewPayload\b/g, "")
    .replace(/EVIDENCE:[A-Za-z0-9_-]+/g, "");
}

export const lossyStripTransform: PromptCostTransform = {
  id: "custom-shorthand",
  description: "Lossy strip of contract markers (negative control for harness)",
  apply: lossyStripContractMarkers,
};

export const EVAL_CANDIDATE_TRANSFORMS: readonly PromptCostTransform[] = [
  baselineTransform,
  compactStaticTransform,
  compactToolResultTransform,
  customShorthandTransform,
];
