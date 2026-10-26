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
