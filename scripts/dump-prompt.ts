import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";
import { makeTestConfig } from "../test/helpers/config.js";
import {
  ORCHESTRATOR_RECON_INSTRUCTION,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
} from "../src/review/orchestrator/prompts/orchestratorPrompts.js";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../src/agent/prompts/securityPrompt.js";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "@earendil-works/pi-agent-core";
import type { Config } from "../src/settings/index.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { buildAskSystemPrompt } from "../src/agent/ask/askPrompt.js";
import { descriptionSystemPrompt } from "../src/agent/description/descriptionSystemPrompt.js";
import { triageSystemPrompt } from "../src/agent/triage/triagePrompt.js";
import { verificationSystemPrompt } from "../src/agent/verification/verificationPrompt.js";
import { CI_SUMMARY_SYSTEM_PROMPT } from "../src/review/ci/ciAuthor.js";
import { BOUND_POLICY_JUDGE_SYSTEM_PROMPT } from "../src/review/publish/boundPolicyJudge.js";
import { buildContext7Tools } from "../src/agent/tools/context7Tools.js";
import { buildUnavailableCodeIndexTools } from "../src/agent/tools/codeIndexTools.js";
import { hideWorkspaceToolsBehindCodeMode } from "../src/agent/codemode/assembleExplorationTools.js";
import { buildSubmitFindingsReportPiTool } from "../src/review/orchestrator/specialistTools.js";
import { buildSpecialistBriefTool } from "../src/review/orchestrator/briefTool.js";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.js";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.js";
import {
  buildPublishSummaryTool,
  createPublishSummaryState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import { createFakePrSurface } from "../src/github/fakePrSurface.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
} from "../src/agent/description/submitDescriptionTool.js";
import {
  buildTriageWorkspaceTools,
  createTriageWorkspaceToolState,
} from "../src/agent/triage/triageWorkspaceTools.js";
import {
  buildSubmitTriageTool,
  createSubmitTriageState,
} from "../src/agent/triage/submitTriageTool.js";
import { buildWorkspaceTools } from "../src/agent/tools/workspaceToolset.js";
import {
  buildSubmitVerificationTool,
  createSubmitVerificationState,
} from "../src/agent/verification/submitVerificationTool.js";
import {
  COMPACTION_CUSTOM_INSTRUCTIONS,
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_PROMPT,
} from "../src/agent/runtime/transcriptCompaction.js";
import { CONTEXT7_RESPONSE_BYTES } from "../src/settings/index.js";

function unavailable(): never {
  throw new Error("Prompt inspection must not execute workspace, config, or provider actions");
}

function dumpAll() {
  const workspace: LocalPrWorkspace = {
    rootDir: "",
    privateGitDir: "",
    agentCwd: "",
    reader: {
      readSource: unavailable,
      readFile: unavailable,
      refuseFile: unavailable,
      agentCwd: "",
      changedFiles: [],
      changedFileByPath: new Map(),
      checkoutPaths: new Set(),
      sortedCheckoutPaths: [],
      checkoutMode: "full",
      diffIndex: createCachedPrDiffIndex(),
      stats: { truncated: false, totalChanges: 0, fileCount: 0 },
      grepLiteral: unavailable,
      getDiffForPath: unavailable,
      getBlameForPath: unavailable,
      isPathInCheckout: () => false,
      getCoverage: () => ({
        mode: "full",
        pathsInCheckout: 0,
        changedFileCount: 0,
        changeSetTruncated: false,
      }),
      noteSearchTruncated: unavailable,
      lookupSymbol: unavailable,
      getSymbolIndexStatus: () => ({ available: false }),
    },
    cleanup: unavailable,
  };
  const checkout: WritablePrCheckout = {
    dir: "",
    reader: {
      readSource: unavailable,
      readFile: unavailable,
      refuseFile: unavailable,
      agentCwd: "",
      grepLiteral: unavailable,
      getDiffForPath: unavailable,
    },
    headRef: "",
    baseSha: "",
    commit: unavailable,
    push: unavailable,
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
  const local = buildWorkspaceTools(workspace.reader);
  const codeModeLocal = hideWorkspaceToolsBehindCodeMode(local, {
    executorKind: "in_process",
  }).piTools;
  const context7 = buildContext7Tools({
    apiKey: "",
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  }).piTools;
  const codeIndex = buildUnavailableCodeIndexTools().piTools;
  const reviewWorkspace = [...codeModeLocal, ...context7, ...codeIndex];
  const specialist = [...reviewWorkspace, buildSubmitFindingsReportPiTool()];
  const phaseRef = { current: "recon" } satisfies Parameters<typeof buildSpecialistBriefTool>[0];
  const ctx = {
    owner: "",
    repo: "",
    prNumber: 0,
    headSha: "",
    hasDescriptionReviewMap: false,
  };
  const { surface: prSurface } = createFakePrSurface(ctx);
  const publishSession = createReviewPublishSession({
    ctx,
    prSurface,
    cachedDiffIndex: workspace.reader.diffIndex,
    resolveProgressCommentUrl: unavailable,
    cfg: makeTestConfig({
      models: { model: "" },
      agentEvents: { enabled: false },
      findingHistory: { enabled: false },

      features: {
        review: "manual",
        describe: "off",
        verification: "off",
        ask: "off",
        triage: "off",
        reviewLabels: "off",
        commitStatus: false,
        titleRewrite: false,
      },
    }),
  });
  const thread = buildPublishThreadTool({ phaseRef, session: publishSession }).piTool;
  const summary = buildPublishSummaryTool({
    phaseRef,
    session: publishSession,
    state: createPublishSummaryState(),
    getLedger: createFindingLedger,
    getCoverage: () => ({ kind: "full" }),
  }).piTool;
  const description = buildSubmitDescriptionTool({
    get cfg(): Config {
      return unavailable();
    },
    prSurface,
    ...ctx,
    state: createSubmitDescriptionState(),
    mapMode: "omit",
  }).piTool;
  const workspaceState = createTriageWorkspaceToolState();
  const triageWorkspace = buildTriageWorkspaceTools({
    get cfg(): Config {
      return unavailable();
    },
    checkout,
    inventory: [],
    state: workspaceState,
  }).piTools;
  const triage = buildSubmitTriageTool({
    ...ctx,
    inventory: [],
    checkout,
    workspaceState,
    submitState: createSubmitTriageState(),
  }).piTool;
  const verificationWorkspace = buildWorkspaceTools({
    profile: "verification",
    reader: workspace.reader,
  });
  const verification = buildSubmitVerificationTool({
    ...ctx,
    inventory: [],
    pushedShas: [],
    submitState: createSubmitVerificationState(),
  }).piTool;
  return {
    systems: {
      correctness: buildAutomatedSystemPrompt(),
      security: automatedSecuritySystemPrompt,
      quality: automatedQualitySystemPrompt,
      tests: automatedReviewTestsSystemPrompt,
      orchestrator: orchestratorSystemPrompt,
      ask: buildAskSystemPrompt(),
      description: descriptionSystemPrompt,
      triage: triageSystemPrompt,
      verification: verificationSystemPrompt,
      ciSummary: CI_SUMMARY_SYSTEM_PROMPT,
      boundPolicyJudge: BOUND_POLICY_JUDGE_SYSTEM_PROMPT,
    },
    tools: {
      correctness: specialist,
      security: specialist,
      quality: specialist,
      tests: specialist,
      orchestrator: [
        ...reviewWorkspace,
        buildSpecialistBriefTool(phaseRef).piTool,
        thread,
        summary,
      ],
      ask: [...codeModeLocal, ...codeIndex, ...context7],
      description: [...local.piTools, description],
      triage: [...triageWorkspace, triage],
      verification: [
        ...hideWorkspaceToolsBehindCodeMode(verificationWorkspace, {
          executorKind: "in_process",
        }).piTools,
        verification,
      ],
      ciSummary: [],
      boundPolicyJudge: [],
    },
    nativeTools: {
      localWorkspace: local.piTools,
      verificationWorkspace: verificationWorkspace.piTools,
    },
    turns: {
      recon: ORCHESTRATOR_RECON_INSTRUCTION,
      judgment: prompts["judgment-turn"],
    },
    compaction: {
      system: SUMMARIZATION_SYSTEM_PROMPT,
      user: SUMMARIZATION_PROMPT,
      customInstructions: COMPACTION_CUSTOM_INSTRUCTIONS,
      summaryPrefix: COMPACTION_SUMMARY_PREFIX,
      summarySuffix: COMPACTION_SUMMARY_SUFFIX,
    },
  };
}

const persona = process.argv[2];
const prompts: Record<string, string> = {
  correctness: buildAutomatedSystemPrompt(),
  judgment: [orchestratorSystemPrompt, ORCHESTRATOR_RECON_INSTRUCTION].join("\n\n"),
  "judgment-turn": renderJudgmentTurn(
    {
      specialist: "correctness",
      report: { status: "no_findings", findings: [] },
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

if (!persona || (persona !== "all" && !(persona in prompts))) {
  console.error(
    `Usage: nub run dump-prompt <persona>  (${Object.keys(prompts).join(" | ")} | all)`,
  );
  process.exit(1);
}
console.log(persona === "all" ? JSON.stringify(dumpAll(), null, 2) : prompts[persona]);
