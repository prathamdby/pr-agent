import {
  causalPublicationContract,
  highStakesTrivialTrapGuidance,
  outOfScopeFilesGuidance,
  readOnlyReviewGuidance,
  severityRubric,
} from "./behavior.ts";
import { communicationGuidance } from "./communication.ts";
import { specialistFindingsReportContract } from "./output.ts";
import {
  agentInstructionFilesGuidance,
  context7OutboundDataGuidance,
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
  context7OutboundDataGuidance,
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
  communicationGuidance,
  "",
  specialistFindingsReportContract,
].join("\n");
