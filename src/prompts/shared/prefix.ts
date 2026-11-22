import {
  causalPublicationContract,
  highStakesTrivialTrapGuidance,
  outOfScopeFilesGuidance,
  readOnlyReviewGuidance,
  scopePushbackGuidance,
  severityRubric,
} from "./behavior.ts";
import { communicationGuidance } from "./communication.ts";
import { specialistFindingsReportContract } from "./output.ts";
import {
  agentInstructionFilesGuidance,
  priorInlineFeedbackGuidance,
  repoPolicyGuidance,
  specialistUntrustedEvidenceGuidance,
  userSupplementGuidance,
  wrapUntrustedEvidence,
} from "./safety.ts";
import { specialistInvestigationHarness } from "./tools.ts";

export const specialistSharedPrefix = [
  readOnlyReviewGuidance,
  "",
  specialistInvestigationHarness,
  "",
  specialistUntrustedEvidenceGuidance,
  userSupplementGuidance,
  "",
  severityRubric,
  "",
  causalPublicationContract,
  "",
  highStakesTrivialTrapGuidance,
  "",
  priorInlineFeedbackGuidance,
  "",
  agentInstructionFilesGuidance,
  "",
  repoPolicyGuidance,
  "",
  outOfScopeFilesGuidance,
  "",
  scopePushbackGuidance,
  "",
  communicationGuidance,
  "",
  specialistFindingsReportContract,
].join("\n");

export function renderSpecialistSystemPrompt(input: {
  readonly sharedHead: string;
  readonly lensBody: string;
  readonly specialist: string;
  readonly specialistFocus: string;
}) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      input.sharedHead,
      "",
      input.lensBody,
      "",
      wrapUntrustedEvidence(`specialist_brief.${input.specialist}_focus`, input.specialistFocus),
    ].join("\n"),
  );
}
