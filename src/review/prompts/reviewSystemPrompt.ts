import {
  compactBugPatternCatalogue,
  compactInvestigationMethod,
  compactReportingGate,
  pathAndSizeGuidance,
  securityTripwiresGuidance,
  proseContractGuidance,
} from "./reviewPromptBlocks.js";
import {
  reviewPayloadPerFindingContracts,
  specialistFindingsReportContract,
} from "../../prompts/shared/output.js";
import {
  causalPublicationContract,
  highStakesTrivialTrapGuidance,
  readOnlyReviewGuidance,
  outOfScopeFilesGuidance,
} from "../../prompts/shared/behavior.js";
import {
  priorInlineFeedbackGuidance,
  agentInstructionFilesGuidance,
  repoPolicyGuidance,
  specialistUntrustedEvidenceGuidance,
  userSupplementGuidance,
  context7OutboundDataGuidance,
} from "../../prompts/shared/safety.js";
import { specialistInvestigationHarness } from "../../prompts/shared/tools.js";
import { readerFirstOutputGuidance } from "../../prompts/shared/communication.js";

export function buildAutomatedSystemPrompt(): string {
  const investigationMethod = [...compactInvestigationMethod];
  const bugPatterns = [...compactBugPatternCatalogue];
  const reportingGate = [...compactReportingGate];
  return [
    "You are the correctness specialist investigator for this pull request. Your job is to find the real, actionable defects its changes introduce: each one has a trigger path you can show from the code. Style, taste, and speculation belong to no specialist.",
    "",
    readOnlyReviewGuidance,
    "",
    specialistInvestigationHarness,
    context7OutboundDataGuidance,
    "",
    specialistUntrustedEvidenceGuidance,
    userSupplementGuidance,
    "",
    "<!-- BEGIN_SHARED_METHODOLOGY -->",
    "",
    "## What to review",
    "Functional correctness and logic; broken contracts, dependencies, or tests; security flaws; and performance regressions — wherever the diff introduces them.",
    "",
    ...investigationMethod,
    "",
    ...bugPatterns,
    "",
    causalPublicationContract,
    "",
    highStakesTrivialTrapGuidance,
    "",
    securityTripwiresGuidance,
    "",
    proseContractGuidance,
    "",
    priorInlineFeedbackGuidance,
    "",
    agentInstructionFilesGuidance,
    "",
    repoPolicyGuidance,
    "",
    ...reportingGate,
    "",
    "<!-- END_SHARED_METHODOLOGY -->",
    "",
    pathAndSizeGuidance,
    "",
    outOfScopeFilesGuidance,
    "",
    readerFirstOutputGuidance,
    "",
    specialistFindingsReportContract,
    "",
    "Finding fields:",
    "- Each finding has severity (P0|P1|P2|P3), file, startLine, endLine, title (imperative, names the defect, <=80 chars), and detail (per the detail contract below, naming the violated invariant).",
    reviewPayloadPerFindingContracts,
  ].join("\n");
}
