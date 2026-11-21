import { readFile } from "node:fs/promises";
import { AppError } from "../../errors/appError.ts";
import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import {
  ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  RECON_MAX_TOOL_ROUNDS,
  REVIEW_SPECIALISTS_BUDGET_MS,
  REVIEW_SPECIALIST_WRAP_UP_MS,
  REVIEW_SPECIALIST_WRAP_UP_TOOL_ROUNDS,
  SPECIALIST_MAX_TOOL_ROUNDS,
  SPECIALIST_WARMUP_LEAD_MAX_MS,
  SUBMIT_ONLY_MAX_TOOL_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.ts";
import type { AgentSessionRole, PiSessionSendOptions } from "../../agent/runtime/types.ts";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.ts";
import { resolveModelPolicy, modelAssignmentForRole } from "../../agent/runtime/modelPolicy.ts";
import { compactionPolicyForRole } from "../../agent/runtime/compactionPolicy.ts";
import { assertWorkspacePath } from "../../prWorkspace/repositoryReader.ts";
import { workPublishRecord, type PublishDb } from "../../state/publish.ts";
import { laneEpochCurrent, workRunById } from "../../state/workRuns.ts";
import { createBoundPolicyJudge } from "../publish/boundPolicyJudge.ts";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.ts";
import { recordedPolicyBaseSha, reviewPolicySummaryAlert } from "../policySnapshotUse.ts";
import {
  createReviewPublishSession,
  type ReviewPublishSession,
} from "../publish/reviewPublishSession.ts";
import { reviewVerdictSurfaces } from "../publish/reviewVerdictSurfaces.ts";
import { recordPublishStepFor } from "../publish/reviewSummaryComment.ts";
import { reviewPayloadFromFindings } from "../reviewSchema.ts";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.ts";
import {
  buildReviewRunSetup,
  ledgerForFindingSource,
  type ReviewRunSetup,
} from "../run/reviewRunSetup.ts";
import { buildSpecialistBriefTool, type SpecialistBrief } from "./briefTool.ts";
import {
  appendTrustedSpecialistContext,
  renderBriefMessage,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
  renderSynthesisTurn,
  ORCHESTRATOR_MISSING_BRIEF_ERROR,
  ORCHESTRATOR_MISSING_SUMMARY_ERROR,
  ORCHESTRATOR_RECOVER_SUMMARY_INSTRUCTION,
  renderOrchestratorReconTurn,
  renderOrchestratorBriefRepair,
  renderOrchestratorSummaryRepair,
} from "../../prompts/orchestrator/prompt.ts";
import {
  createFindingLedger,
  ledgerFindings,
  SPECIALIST_IDS,
  specialistDonePhase,
  type FindingLedger,
  type FindingSource,
  type OrchestratedRunState,
  type ReviewCoverage,
  type SpecialistId,
  type SpecialistOutcome,
  type SpecialistRunPhase,
} from "./orchestratorTypes.ts";
import { createOrchestratorPhaseRef, type OrchestratorPhaseRef } from "./phaseToolPolicy.ts";
import { buildPublishSummaryTool, createPublishSummaryState } from "./publishSummaryTool.ts";
import { buildPublishThreadTool } from "./publishThreadTool.ts";
import { buildDeclareDuplicateTool } from "./declareDuplicateTool.ts";
import { judgmentInventory } from "./judgmentInventory.ts";
import { slimAcceptedFindings } from "./slimAcceptedFindings.ts";
import {
  loadFindingInventoryOrUnavailable,
  openReviewThreads,
  type AcceptedOpenThread,
  type FindingInventory,
} from "../findingIdentity/findingInventory.ts";
import { buildFindingView, type FindingCheck } from "../findingIdentity/findingLifecycle.ts";
import { nextSynthesisStep } from "./runStep.ts";
import { buildSubmitTool, SPECIALIST_LENS_BODIES, type SubmissionState } from "./specialistRun.ts";
import { buildSpecialistSessionTools, SUBMIT_FINDINGS_REPORT_NAME } from "./specialistTools.ts";
import {
  emptyReconPack,
  hydrateReconPack,
  reviewPromptCacheKey,
  type ReconPack,
} from "./hydrateReconPack.ts";
import {
  renderSpecialistSystemPrompt,
  specialistSharedPrefix,
} from "../../prompts/shared/prefix.ts";
import {
  MISSING_REPORT_ERROR,
  renderSpecialistReportRepair,
  SPECIALIST_WRAP_UP_STEER,
} from "../../prompts/shared/repair.ts";
import { specialistReportSchema, type SpecialistReport } from "./specialistReport.ts";
import { tickProgressComment, writeCancelledProgressComment } from "./stubTick.ts";
import {
  OPENED_PATH_MAX_CHARS,
  createEvidenceLedger,
  hashNormalizedLineText,
  unreadChangedFilesNote,
  unreadChangedPaths,
  type EvidenceLedger,
} from "../findings/evidenceLedger.ts";
import { assertFindingsHaveEvidence } from "../findings/evidenceValidator.ts";
import { tryLightweightAutoReviewCompletion } from "../../agentWork/reviewLightweightCompletion.ts";
import type { ReviewAttemptEnv } from "../runReviewForWorkItem.ts";
import * as v from "valibot";

export const UNREAD_COVERAGE_PATH_LIMIT = 500;

export type ReviewConversationRole = "orchestrator" | SpecialistId;
export const REVIEW_CONVERSATION_ROLES: readonly ReviewConversationRole[] = [
  "orchestrator",
  ...SPECIALIST_IDS,
];

export type StoredSpecialistOutcome =
  | {
      readonly kind: "complete" | "partial";
      readonly report: SpecialistReport;
      readonly durationMs: number;
    }
  | { readonly kind: "failed"; readonly message: string; readonly durationMs: number };

export type SpecialistTrack = {
  readonly conversationId?: string;
  readonly turnNo: number;
  readonly stage: "idle" | "investigating" | "wrap_up" | "repair" | "settled";
  readonly repairs: number;
  readonly retries: number;
  readonly startedAt?: number;
  readonly outcome?: StoredSpecialistOutcome;
};

export type OrchestratorStep =
  | "recon"
  | "repair_brief"
  | "judgment"
  | "synthesis"
  | "repair_summary"
  | "recover_summary";

export type ReviewAttemptPhase =
  | "recon"
  | "dispatch_specialists"
  | "wait_specialists"
  | "synthesize_and_validate"
  | "publish";

export type ReviewLifecycle =
  | { readonly kind: "running" }
  | { readonly kind: "finalizing" }
  | { readonly kind: "stopped"; readonly reason: "superseded" | "stale_head" | "cancelled" };

export type ReviewAttemptCheckpoint = {
  readonly phase: ReviewAttemptPhase;
  readonly started: boolean;
  readonly headSha: string;
  readonly timing: {
    readonly startedAt: number;
    readonly reconAt: number;
    readonly modelStopAt: number;
    readonly returnBy: number;
  };
  readonly orchestrator: {
    readonly conversationId?: string;
    readonly turnNo: number;
    readonly retired: boolean;
    readonly repairs: number;
    readonly recoveries: number;
    readonly synthesisSent: boolean;
    readonly inFlight?: {
      readonly step: OrchestratorStep;
      readonly turnNo: number;
      readonly specialist?: SpecialistId;
      readonly threadCallsBefore?: number;
    };
  };
  readonly brief?: SpecialistBrief;
  readonly briefFallback: boolean;
  readonly judgment: "model" | "degraded";
  readonly recon?: {
    readonly text: string;
    readonly hash: string;
    readonly creditedLines: ReconPack["creditedLines"];
    readonly promptCacheKey: string;
  };
  readonly specialistTiming?: { readonly deadlineAt: number; readonly wrapUpAt: number };
  readonly warmup: { readonly releaseAt?: number; readonly released: boolean };
  readonly specialists: Readonly<Record<SpecialistId, SpecialistTrack>>;
  readonly completionOrder: readonly SpecialistId[];
  readonly validated: boolean;
  readonly judged: readonly SpecialistId[];
  readonly unjudged: readonly SpecialistId[];
  readonly ledger: FindingLedger;
  readonly summary: { readonly published: boolean; readonly check: FindingCheck | null };
  readonly progressRevision: OrchestratedRunState["progressRevision"];
  readonly lifecycle: ReviewLifecycle;
};

export type ReviewTurnRequest = {
  readonly role: ReviewConversationRole;
  readonly turnNo: number;
  readonly prompt: string;
  readonly opts: PiSessionSendOptions;
};

export type ReviewAttemptResult =
  | { readonly status: "completed"; readonly published: boolean }
  | { readonly status: "cancelled"; readonly reason: string };

export type ReviewPhaseStep =
  | { readonly kind: "advance"; readonly checkpoint: ReviewAttemptCheckpoint }
  | {
      readonly kind: "create_child";
      readonly role: ReviewConversationRole;
      readonly checkpoint: ReviewAttemptCheckpoint;
    }
  | {
      readonly kind: "submit";
      readonly turn: ReviewTurnRequest;
      readonly checkpoint: ReviewAttemptCheckpoint;
    }
  | {
      readonly kind: "park";
      readonly checkpoint: ReviewAttemptCheckpoint;
      readonly waitFor: readonly {
        readonly role: ReviewConversationRole;
        readonly turnNo: number;
      }[];
      readonly until?: number;
    }
  | {
      readonly kind: "abort_children";
      readonly roles: readonly ReviewConversationRole[];
      readonly checkpoint: ReviewAttemptCheckpoint;
    }
  | {
      readonly kind: "finish";
      readonly checkpoint: ReviewAttemptCheckpoint;
      readonly result: ReviewAttemptResult;
    };

export type SettledTurnView =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly text: string; readonly stopReason: string | undefined }
  | { readonly status: "unanswered"; readonly reason: string };

export type TranscriptToolCallView = {
  readonly assistantOrdinal: number;
  readonly args: Record<string, unknown>;
  readonly resultText: string | undefined;
};

export type ReviewTurnReader = {
  readonly now: () => number;
  readonly settled: (role: ReviewConversationRole, turnNo: number) => Promise<SettledTurnView>;
  readonly toolCalls: (
    role: ReviewConversationRole,
    toolName: string,
  ) => Promise<readonly TranscriptToolCallView[]>;
  readonly creditEvidence: (
    role: ReviewConversationRole,
    ledger: EvidenceLedger,
    uptoAssistantOrdinal: number,
  ) => Promise<void>;
};

export type ReviewChildTools = {
  readonly piTools: readonly ReviewRunSetup["workspaceTools"]["piTools"][number][];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly durableTools?: ReviewRunSetup["workspaceTools"]["durableTools"];
  readonly toolMeta?: ReviewRunSetup["workspaceTools"]["toolMeta"];
};

export type ReviewChildRequest = {
  readonly role: AgentSessionRole;
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly systemPromptSharedHead?: string;
  readonly headSha: string;
  readonly cwd: string;
  readonly tools: ReviewChildTools;
  readonly reconEvidence?: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly lines: readonly number[];
    readonly content: string;
  }[];
  readonly providerSessionId?: string;
  readonly compaction: boolean;
};

export type ReviewAttemptLive = {
  readonly env: ReviewAttemptEnv;
  readonly setup: ReviewRunSetup;
  readonly phaseRef: OrchestratorPhaseRef;
  readonly inventory: FindingInventory;
  readonly session: ReviewPublishSession;
  readonly briefTool: ReturnType<typeof buildSpecialistBriefTool>;
  readonly publishThread: ReturnType<typeof buildPublishThreadTool>;
  readonly summaryState: ReturnType<typeof createPublishSummaryState>;
  readonly orchestratorTools: ReviewChildTools;
  readonly submitStates: ReadonlyMap<SpecialistId, SubmissionState>;
  readonly specialistTools: (specialist: SpecialistId) => ReviewChildTools;
  readonly setEvidenceCreditor: (specialist: SpecialistId, credit: () => void) => void;
  readonly escalation?: EscalationPlan;
  readonly dispose: () => Promise<void>;
};

export const REVIEW_PHASES: readonly ReviewAttemptPhase[] = [
  "recon",
  "dispatch_specialists",
  "wait_specialists",
  "synthesize_and_validate",
  "publish",
];

function emptyTrack() {
  return ((pinnedReturn: SpecialistTrack) => pinnedReturn)({
    turnNo: 0,
    stage: "idle",
    repairs: 0,
    retries: 0,
  });
}

export function initialReviewCheckpoint(params: {
  readonly now: number;
  readonly headSha: string;
  readonly budgetMs: number;
  readonly finalizationMs: number;
  readonly reconBudgetMs: number;
}) {
  const returnBy = params.now + params.budgetMs;
  return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
    phase: "recon",
    started: false,
    headSha: params.headSha,
    timing: {
      startedAt: params.now,
      reconAt: params.now + params.reconBudgetMs,
      modelStopAt: Math.max(params.now, returnBy - params.finalizationMs),
      returnBy,
    },
    orchestrator: { turnNo: 0, retired: false, repairs: 0, recoveries: 0, synthesisSent: false },
    briefFallback: false,
    judgment: "model",
    warmup: { released: false },
    specialists: {
      correctness: emptyTrack(),
      security: emptyTrack(),
      quality: emptyTrack(),
      tests: emptyTrack(),
    },
    completionOrder: [],
    validated: false,
    judged: [],
    unjudged: [],
    ledger: createFindingLedger(),
    summary: { published: false, check: null },
    progressRevision: 0,
    lifecycle: { kind: "running" },
  });
}

function withTrack(
  checkpoint: ReviewAttemptCheckpoint,
  specialist: SpecialistId,
  patch: Partial<SpecialistTrack>,
) {
  return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
    ...checkpoint,
    specialists: {
      ...checkpoint.specialists,
      [specialist]: { ...checkpoint.specialists[specialist], ...patch },
    },
  });
}

function withOrchestrator(
  checkpoint: ReviewAttemptCheckpoint,
  patch: Partial<ReviewAttemptCheckpoint["orchestrator"]>,
) {
  return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
    ...checkpoint,
    orchestrator: { ...checkpoint.orchestrator, ...patch },
  });
}

export function withConversationId(
  checkpoint: ReviewAttemptCheckpoint,
  role: ReviewConversationRole,
  conversationId: string,
) {
  if (role === "orchestrator") return withOrchestrator(checkpoint, { conversationId });
  return withTrack(checkpoint, role, { conversationId });
}

export function conversationIdFor(
  checkpoint: ReviewAttemptCheckpoint,
  role: ReviewConversationRole,
) {
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    role === "orchestrator"
      ? checkpoint.orchestrator.conversationId
      : checkpoint.specialists[role].conversationId,
  );
}

function sharedHeadFor(checkpoint: ReviewAttemptCheckpoint) {
  const text = checkpoint.recon?.text ?? "";
  return ((pinnedReturn: string) => pinnedReturn)(
    text.length > 0 ? `${specialistSharedPrefix}\n\n${text}` : specialistSharedPrefix,
  );
}

function reconEvidenceFor(checkpoint: ReviewAttemptCheckpoint) {
  return (checkpoint.recon?.creditedLines ?? []).map((credited) => {
    const lines: number[] = [];
    for (let line = credited.startLine; line <= credited.endLine; line += 1) lines.push(line);
    return {
      path: credited.path,
      contentHash: hashNormalizedLineText(credited.content),
      startLine: credited.startLine,
      endLine: credited.endLine,
      lines,
      content: credited.content,
    };
  });
}

export function reviewChildRequest(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
  role: ReviewConversationRole,
) {
  const cfg = live.env.cfg;
  const policy = resolveModelPolicy(cfg);
  const sessionRole: AgentSessionRole = role === "orchestrator" ? "orchestrator" : "specialist";
  const primary = live.escalation?.model ?? modelAssignmentForRole(policy, sessionRole);
  const cwd = live.env.repositoryView.agentCwd;
  if (role === "orchestrator")
    return ((pinnedReturn: ReviewChildRequest) => pinnedReturn)({
      role: sessionRole,
      provider: primary.provider,
      model: primary.model,
      systemPrompt: orchestratorSystemPrompt,
      headSha: checkpoint.headSha,
      cwd,
      tools: live.orchestratorTools,
      compaction: compactionPolicyForRole(sessionRole).enabled,
    });
  const brief = checkpoint.brief ?? fallbackBrief(liveChangedPaths(live));
  const sharedHead = sharedHeadFor(checkpoint);
  return ((pinnedReturn: ReviewChildRequest) => pinnedReturn)({
    role: sessionRole,
    provider: primary.provider,
    model: primary.model,
    systemPrompt: renderSpecialistSystemPrompt({
      sharedHead,
      lensBody: SPECIALIST_LENS_BODIES[role],
      specialist: role,
      specialistFocus: brief.specialistFocus[role],
    }),
    systemPromptSharedHead: sharedHead,
    headSha: checkpoint.headSha,
    cwd,
    tools: live.specialistTools(role),
    reconEvidence: reconEvidenceFor(checkpoint),
    ...(checkpoint.recon !== undefined
      ? { providerSessionId: checkpoint.recon.promptCacheKey }
      : {}),
    compaction: compactionPolicyForRole(sessionRole).enabled,
  });
}

function liveChangedPaths(live: ReviewAttemptLive) {
  return live.env.repositoryView.workspace.reader.changedFiles.map((file) => file.path);
}

export async function openReviewAttemptLive(params: {
  readonly env: ReviewAttemptEnv;
  readonly checkpoint: ReviewAttemptCheckpoint | undefined;
  readonly escalation?: EscalationPlan;
}) {
  const env = params.env;
  const item = env.item;
  const workspace = env.repositoryView.workspace;
  const setup = buildReviewRunSetup({
    cfg: env.cfg,
    prSurface: env.prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha: env.headSha,
    userSupplement: item.payload.userSupplement,
    trustedContext: env.trustedContext,
    workspace,
    workItemId: item.id,
  });
  const phaseRef = createOrchestratorPhaseRef("recon");
  const inventory = await loadFindingInventoryOrUnavailable(env.prSurface, {
    renames: new Map(
      workspace.reader.changedFiles.flatMap((file) =>
        file.status === "renamed" && file.oldPath != null
          ? [[file.oldPath, file.path] as const]
          : [],
      ),
    ),
    deletedPaths: new Set(
      workspace.reader.changedFiles
        .filter((file) => file.status === "deleted")
        .map((file) => file.path),
    ),
  });
  const session = createReviewPublishSession({
    cfg: env.cfg,
    ctx: {
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      headSha: env.headSha,
      hasDescriptionReviewMap: false,
    },
    prSurface: setup.prSurface,
    findingInventory: inventory,
    mode: item.reviewLens,
    cachedDiffIndex: setup.cachedDiffIndex,
    recordPublishStep: recordPublishStepFor(env.target, item.reviewLens),
    workItemId: item.id,
    publish: env.target,
    headCi: env.headCi,
    commitStatusEnabled: env.cfg.features.commitStatus,
    resolveProgressCommentUrl: async () => {
      const record = workPublishRecord(env.db, item.id, "progress_comment");
      const id = record?.githubId ?? undefined;
      return id == null
        ? undefined
        : `https://github.com/${item.owner}/${item.repo}/pull/${item.prNumber}#issuecomment-${id}`;
    },
    shouldAbortPublish: async () => !reviewWorkIsCurrent(env.db, item.id),
    policyAlert: reviewPolicySummaryAlert(workspace.policySnapshot, workspace.reader.changedFiles),
  });
  const sourceLedger = (source: FindingSource) =>
    ledgerForFindingSource(source, {
      orchestrator: setup.evidenceLedger,
      specialists: setup.specialistLedgers,
    });
  const briefTool = buildSpecialistBriefTool(
    phaseRef,
    params.checkpoint?.brief !== undefined ? { initialBrief: params.checkpoint.brief } : undefined,
  );
  const publishThread = buildPublishThreadTool({
    phaseRef,
    session,
    policy: {
      repoPolicy: env.repoPolicy,
      policyBaseSha: recordedPolicyBaseSha(workspace.policySnapshot),
      boundPolicyJudge: createBoundPolicyJudge(env.cfg),
      readCheckoutFile: async (relativePath) => {
        try {
          return await readFile(assertWorkspacePath(workspace.agentCwd, relativePath), "utf8");
        } catch {
          return undefined;
        }
      },
      checkoutCoverage: workspace.reader.getCoverage(),
      isPathInCheckout: (path) => workspace.reader.isPathInCheckout(path),
    },
    inventory,
    evidenceLedgerFor: sourceLedger,
    initialLedger: createFindingLedger(params.checkpoint?.ledger),
  });
  setup.bindReviewThreads(() =>
    openReviewThreads(inventory, acceptedOpenThreads(publishThread.getLedger())),
  );
  const summaryState = createPublishSummaryState({
    published: params.checkpoint?.summary.published ?? false,
    check: params.checkpoint?.summary.check ?? null,
  });
  const coverageNow = () => coverageFor(liveRef.current, params.checkpoint);
  const publishSummary = buildPublishSummaryTool({
    phaseRef,
    session,
    state: summaryState,
    getLedger: publishThread.getLedger,
    getCoverage: () => coverageNow(),
  });
  const declareDuplicate = buildDeclareDuplicateTool({ phaseRef, session });
  const orchestratorTools: ReviewChildTools = {
    piTools: [
      ...setup.workspaceTools.piTools,
      briefTool.piTool,
      publishThread.piTool,
      declareDuplicate.piTool,
      publishSummary.piTool,
    ],
    executors: {
      ...setup.workspaceTools.executors,
      submit_specialist_brief: briefTool.executor,
      publish_thread: publishThread.executor,
      declare_duplicate: declareDuplicate.executor,
      publish_summary: publishSummary.executor,
    },
    durableTools: setup.workspaceTools.durableTools,
    toolMeta: setup.workspaceTools.toolMeta,
  };
  const submitStates = new Map<SpecialistId, SubmissionState>();
  const creditors = new Map<SpecialistId, () => void>();
  const builtSpecialistTools = new Map<SpecialistId, ReviewChildTools>();
  const threadsAtDispatch = () =>
    openReviewThreads(inventory, acceptedOpenThreads(publishThread.getLedger()));
  const specialistTools = (specialist: SpecialistId) => {
    const existing = builtSpecialistTools.get(specialist);
    if (existing !== undefined) return existing;
    const state: SubmissionState = { report: null, validationError: null };
    submitStates.set(specialist, state);
    const submit = buildSubmitTool(
      state,
      { cfg: env.cfg, cwd: workspace.agentCwd, specialist },
      {
        ledger: setup.specialistLedgers[specialist],
        creditEvidence: () => creditors.get(specialist)?.(),
        headSha: env.headSha,
        checkoutCoverage: workspace.reader.getCoverage(),
        isPathInCheckout: (path) => workspace.reader.isPathInCheckout(path),
        specialist,
        cfg: env.cfg,
      },
    );
    const sessionTools = buildSpecialistSessionTools(
      setup.createSpecialistWorkspaceTools(specialist, threadsAtDispatch),
      submit,
    );
    const tools: ReviewChildTools = {
      piTools: sessionTools.piTools,
      executors: sessionTools.executors,
      ...(sessionTools.durableTools !== undefined
        ? { durableTools: sessionTools.durableTools }
        : {}),
      ...(sessionTools.toolMeta !== undefined ? { toolMeta: sessionTools.toolMeta } : {}),
    };
    builtSpecialistTools.set(specialist, tools);
    return tools;
  };
  const inFlight = params.checkpoint?.orchestrator.inFlight;
  if (inFlight?.step === "judgment" && inFlight.specialist !== undefined) {
    const outcome = params.checkpoint?.specialists[inFlight.specialist].outcome;
    publishThread.setSource(inFlight.specialist);
    if (outcome !== undefined && outcome.kind !== "failed") publishThread.setReport(outcome.report);
  }
  const live: ReviewAttemptLive = {
    env,
    setup,
    phaseRef,
    inventory,
    session,
    briefTool,
    publishThread,
    summaryState,
    orchestratorTools,
    submitStates,
    specialistTools,
    setEvidenceCreditor: (specialist, credit) => {
      creditors.set(specialist, credit);
    },
    ...(params.escalation !== undefined ? { escalation: params.escalation } : {}),
    dispose: async () => {
      await setup.disposeSpillFiles().catch(() => undefined);
      await env.dispose();
    },
  };
  const liveRef = { current: live };
  return live;
}

export function reviewWorkIsCurrent(db: PublishDb, workId: string) {
  const run = workRunById(db, workId);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    run !== undefined &&
      run.status === "running" &&
      run.cancel_reason === null &&
      laneEpochCurrent(db, run),
  );
}

const cancelAttributionSchema = v.object({
  cancelAttribution: v.optional(
    v.union([
      v.object({ kind: v.literal("user"), login: v.string() }),
      v.object({ kind: v.literal("merged") }),
      v.object({ kind: v.literal("closed") }),
    ]),
  ),
});

function cancelAttributionFor(db: PublishDb, workId: string) {
  const run = workRunById(db, workId);
  if (run === undefined) return undefined;
  const parsed = v.safeParse(cancelAttributionSchema, JSON.parse(run.payload_json));
  return parsed.success ? parsed.output.cancelAttribution : undefined;
}

function stopReasonFor(db: PublishDb, workId: string) {
  const run = workRunById(db, workId);
  return ((pinnedReturn: "superseded" | "cancelled") => pinnedReturn)(
    run?.status === "cancelled" || run?.cancel_reason != null ? "cancelled" : "superseded",
  );
}

function coverageFor(live: ReviewAttemptLive, checkpoint: ReviewAttemptCheckpoint | undefined) {
  const failed: SpecialistId[] = [];
  const partial: SpecialistId[] = [];
  for (const specialist of SPECIALIST_IDS) {
    const outcome = checkpoint?.specialists[specialist].outcome;
    if (outcome?.kind === "failed") failed.push(specialist);
    if (outcome?.kind === "partial") partial.push(specialist);
  }
  const unread = unreadChangedPaths({
    ledgers: [
      live.setup.evidenceLedger,
      ...SPECIALIST_IDS.map((specialist) => live.setup.specialistLedgers[specialist]),
    ],
    changedFiles: live.env.repositoryView.workspace.reader.changedFiles,
    isPathInCheckout: (path) => live.env.repositoryView.workspace.reader.isPathInCheckout(path),
  });
  return ((pinnedReturn: ReviewCoverage) => pinnedReturn)(
    reviewRunCoverage(failed, unread, checkpoint?.unjudged ?? [], partial),
  );
}

function specialistPhases(checkpoint: ReviewAttemptCheckpoint) {
  const phase = (specialist: SpecialistId) => {
    const track = checkpoint.specialists[specialist];
    if (checkpoint.unjudged.includes(specialist))
      return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)({ phase: "unjudged" });
    if (track.outcome === undefined)
      return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)({
        phase: track.stage === "idle" ? "waiting" : "running",
      });
    if (track.outcome.kind === "failed")
      return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)({ phase: "failed" });
    if (track.outcome.report.status === "no_findings")
      return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)({ phase: "no_findings" });
    if (checkpoint.judged.includes(specialist))
      return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)(
        specialistDonePhase(createFindingLedger(), checkpoint.ledger, specialist),
      );
    return ((pinnedReturn: SpecialistRunPhase) => pinnedReturn)({ phase: "running" });
  };
  return {
    correctness: phase("correctness"),
    security: phase("security"),
    quality: phase("quality"),
    tests: phase("tests"),
  };
}

async function writeTick(live: ReviewAttemptLive, checkpoint: ReviewAttemptCheckpoint) {
  const revision = checkpoint.progressRevision;
  if (revision === 0 || revision === 7) return;
  const item = live.env.item;
  await tickProgressComment({
    coordination: live.env.target,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    mode: item.reviewLens,
    headSha: checkpoint.headSha,
    source: item.source,
    progressRevision: revision,
    tickState: {
      kind: "specialists",
      recon: checkpoint.brief !== undefined || checkpoint.briefFallback ? "done" : "running",
      specialists: specialistPhases(checkpoint),
    },
    prSurface: live.setup.prSurface,
    headCi: live.env.headCi,
  });
}

function outcomeOf(specialist: SpecialistId, stored: StoredSpecialistOutcome) {
  if (stored.kind === "failed")
    return ((pinnedReturn: SpecialistOutcome) => pinnedReturn)({
      kind: "failed",
      specialist,
      durationMs: stored.durationMs,
      error: new AppError({
        domain: "review",
        kind: "specialist_failed",
        message: stored.message,
        context: { specialist },
      }),
    });
  return ((pinnedReturn: SpecialistOutcome) => pinnedReturn)({
    kind: stored.kind,
    specialist,
    durationMs: stored.durationMs,
    report: stored.report,
  });
}

function acceptedResult(text: string | undefined) {
  if (text === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "accepted" in parsed &&
      parsed.accepted === true
    );
  } catch {
    return false;
  }
}

async function recoverBrief(live: ReviewAttemptLive, io: ReviewTurnReader) {
  const existing = live.briefTool.getBrief();
  if (existing !== null) return existing;
  const calls = await io.toolCalls("orchestrator", "submit_specialist_brief");
  for (const call of calls.toReversed()) {
    if (!acceptedResult(call.resultText)) continue;
    await live.briefTool.executor(call.args);
    const brief = live.briefTool.getBrief();
    if (brief !== null) return brief;
  }
  return null;
}

async function recoverReport(
  live: ReviewAttemptLive,
  io: ReviewTurnReader,
  specialist: SpecialistId,
) {
  const inMemory = live.submitStates.get(specialist)?.report;
  if (inMemory != null) return inMemory;
  const calls = await io.toolCalls(specialist, SUBMIT_FINDINGS_REPORT_NAME);
  for (const call of calls.toReversed()) {
    if (!acceptedResult(call.resultText)) continue;
    const parsed = v.safeParse(specialistReportSchema, call.args);
    if (parsed.success) return parsed.output;
  }
  return null;
}

function specialistTurn(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
  specialist: SpecialistId,
  kind: "investigate" | "wrap_up" | "repair",
  validationError?: string,
) {
  const investigationRounds = escalatedToolRounds(
    REVIEW_SPECIALIST_WRAP_UP_TOOL_ROUNDS,
    live.escalation,
  );
  const brief = checkpoint.brief ?? fallbackBrief(liveChangedPaths(live));
  const prompt =
    kind === "investigate"
      ? appendTrustedSpecialistContext(
          renderBriefMessage(
            brief,
            specialist,
            checkpoint.brief === undefined
              ? {
                  pullRequestMetadata: {
                    title: live.env.pullRequest?.title ?? "",
                    body: live.env.pullRequest?.body ?? null,
                  },
                }
              : undefined,
          ),
          live.setup.trustedContext,
        )
      : kind === "wrap_up"
        ? SPECIALIST_WRAP_UP_STEER
        : renderSpecialistReportRepair(validationError ?? MISSING_REPORT_ERROR);
  const maxToolRounds =
    kind === "investigate"
      ? investigationRounds
      : kind === "wrap_up"
        ? Math.max(
            1,
            escalatedToolRounds(SPECIALIST_MAX_TOOL_ROUNDS, live.escalation) - investigationRounds,
          )
        : SUBMIT_ONLY_MAX_TOOL_ROUNDS;
  const track = checkpoint.specialists[specialist];
  return ((pinnedReturn: ReviewTurnRequest) => pinnedReturn)({
    role: specialist,
    turnNo: track.turnNo,
    prompt,
    opts: {
      phase: "specialist",
      checkpointId: `specialist:${specialist}:${track.turnNo}`,
      maxToolRounds,
      reservedTerminalTool: SUBMIT_FINDINGS_REPORT_NAME,
      ...(kind === "investigate" && checkpoint.specialistTiming !== undefined
        ? { stopAtMs: checkpoint.specialistTiming.wrapUpAt }
        : {}),
      ...(kind === "repair" ? { traceValidationRepair: true } : {}),
    },
  });
}

function submitSpecialist(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
  specialist: SpecialistId,
  kind: "investigate" | "wrap_up" | "repair",
  now: number,
  validationError?: string,
) {
  const turn = specialistTurn(live, checkpoint, specialist, kind, validationError);
  const track = checkpoint.specialists[specialist];
  const next = withTrack(checkpoint, specialist, {
    turnNo: track.turnNo + 1,
    stage: kind === "investigate" ? "investigating" : kind === "wrap_up" ? "wrap_up" : "repair",
    repairs: kind === "repair" ? track.repairs + 1 : track.repairs,
    startedAt: track.startedAt ?? now,
  });
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "submit",
    turn,
    checkpoint: next,
  });
}

function orchestratorTurn(
  checkpoint: ReviewAttemptCheckpoint,
  step: OrchestratorStep,
  prompt: string,
  opts: Omit<PiSessionSendOptions, "phase" | "checkpointId">,
  extra: { readonly specialist?: SpecialistId; readonly threadCallsBefore?: number } = {},
) {
  const turnNo = checkpoint.orchestrator.turnNo;
  const phase =
    step === "recon" || step === "repair_brief"
      ? "recon"
      : step === "judgment"
        ? "judgment"
        : "synthesis";
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "submit",
    turn: {
      role: "orchestrator",
      turnNo,
      prompt,
      opts: { ...opts, phase, checkpointId: `orchestrator:${step}:${turnNo}` },
    },
    checkpoint: withOrchestrator(checkpoint, {
      turnNo: turnNo + 1,
      inFlight: { step, turnNo, ...extra },
    }),
  });
}

export async function gateReviewPhase(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
) {
  if (checkpoint.lifecycle.kind !== "running") return checkpoint;
  if (!reviewWorkIsCurrent(live.env.db, live.env.item.id))
    return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
      ...checkpoint,
      lifecycle: { kind: "stopped", reason: stopReasonFor(live.env.db, live.env.item.id) },
    });
  if (Date.now() >= checkpoint.timing.modelStopAt)
    return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
      ...checkpoint,
      lifecycle: { kind: "finalizing" },
    });
  return checkpoint;
}

async function startAttempt(live: ReviewAttemptLive, checkpoint: ReviewAttemptCheckpoint) {
  const env = live.env;
  const verdict = reviewVerdictSurfaces({
    target: env.target,
    prSurface: live.setup.prSurface,
    owner: env.item.owner,
    repo: env.item.repo,
    prNumber: env.item.prNumber,
    reviewLens: env.item.reviewLens,
    headSha: checkpoint.headSha,
    commitStatusEnabled: env.cfg.features.commitStatus,
  });
  await verdict.pending();
  const lightweight = await tryLightweightAutoReviewCompletion(env.target, {
    item: { ...env.item, headSha: checkpoint.headSha },
    reviewLens: env.item.reviewLens,
    prSurface: live.setup.prSurface,
    preflight: env.repositoryView.preflight,
    model: env.cfg.models.model,
    headCi: env.headCi,
    isCurrent: () => reviewWorkIsCurrent(env.db, env.item.id),
    checkFailSeverity: env.cfg.review.checkFailSeverity,
  });
  if (!lightweight.handled) return undefined;
  if (lightweight.published) {
    await reviewVerdictSurfaces({
      target: env.target,
      prSurface: live.setup.prSurface,
      owner: env.item.owner,
      repo: env.item.repo,
      prNumber: env.item.prNumber,
      reviewLens: env.item.reviewLens,
      headSha: checkpoint.headSha,
      commitStatusEnabled: env.cfg.features.commitStatus,
      summaryCommentId: Number(lightweight.summaryId),
    }).close({
      kind: "published",
      ...lightweight.check,
      ...(lightweight.check.conclusion === "success"
        ? { summary: "Documentation-only change set." }
        : {}),
    });
  }
  return ((pinnedReturn: ReviewAttemptResult) => pinnedReturn)({
    status: "completed",
    published: lightweight.published,
  });
}

export async function reconPhase(
  live: ReviewAttemptLive,
  entered: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  const checkpoint = await gateReviewPhase(live, entered);
  if (checkpoint.lifecycle.kind === "stopped")
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "advance",
      checkpoint: { ...checkpoint, phase: "publish" },
    });
  if (!checkpoint.started) {
    const lightweight = await startAttempt(live, checkpoint);
    if (lightweight !== undefined)
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "finish",
        checkpoint: {
          ...checkpoint,
          started: true,
          summary: {
            published: lightweight.status === "completed" && lightweight.published,
            check: null,
          },
        },
        result: lightweight,
      });
    const started = { ...checkpoint, started: true, progressRevision: 1 as const };
    await writeTick(live, started);
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "advance",
      checkpoint: started,
    });
  }
  const orchestrator = checkpoint.orchestrator;
  if (orchestrator.conversationId === undefined && !orchestrator.retired)
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "create_child",
      role: "orchestrator",
      checkpoint,
    });
  const now = io.now();
  live.phaseRef.current = "recon";
  const userContent = live.setup.orchestratorUserContent;
  if (
    orchestrator.inFlight === undefined &&
    checkpoint.brief === undefined &&
    !orchestrator.retired &&
    orchestrator.turnNo === 0
  )
    return orchestratorTurn(checkpoint, "recon", renderOrchestratorReconTurn(userContent), {
      maxToolRounds: escalatedToolRounds(RECON_MAX_TOOL_ROUNDS, live.escalation),
    });
  let current = checkpoint;
  const inFlight = orchestrator.inFlight;
  if (inFlight !== undefined) {
    const settled = await io.settled("orchestrator", inFlight.turnNo);
    if (settled.status === "pending") {
      if (now < checkpoint.timing.reconAt && checkpoint.lifecycle.kind === "running")
        return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
          kind: "park",
          checkpoint,
          waitFor: [{ role: "orchestrator", turnNo: inFlight.turnNo }],
          until: checkpoint.timing.reconAt,
        });
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "abort_children",
        roles: ["orchestrator"],
        checkpoint: {
          ...withOrchestrator(checkpoint, { retired: true, inFlight: undefined }),
          judgment: "degraded",
        },
      });
    }
    current = withOrchestrator(checkpoint, { inFlight: undefined });
    if (settled.status === "unanswered") current = { ...current, judgment: "degraded" };
    const brief = await recoverBrief(live, io);
    if (
      brief === null &&
      settled.status === "done" &&
      current.orchestrator.repairs < VALIDATION_REPAIR_ROUNDS &&
      now < checkpoint.timing.reconAt
    ) {
      const validationError =
        live.briefTool.getValidationError() ?? ORCHESTRATOR_MISSING_BRIEF_ERROR;
      live.briefTool.clearValidationError();
      return orchestratorTurn(
        withOrchestrator(current, { repairs: current.orchestrator.repairs + 1 }),
        "repair_brief",
        renderOrchestratorBriefRepair(validationError),
        { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
      );
    }
    if (brief !== null) current = { ...current, brief };
  }
  const brief = current.brief ?? (await recoverBrief(live, io)) ?? undefined;
  const reconPack = await hydrateReconPack({
    reader: live.env.repositoryView.workspace.reader,
    pointers: brief?.contextPointers ?? [],
  }).catch((error: unknown) => {
    logWarn("review_recon_pack_failed", { message: errorMessage(error) });
    return emptyReconPack();
  });
  const item = live.env.item;
  const specialistsBudget = Math.max(
    0,
    Math.min(
      live.env.cfg.review.specialistTimeoutMs,
      REVIEW_SPECIALISTS_BUDGET_MS,
      checkpoint.timing.modelStopAt - now,
    ),
  );
  const finalized: ReviewAttemptCheckpoint = {
    ...current,
    ...(brief !== undefined ? { brief } : {}),
    briefFallback: brief === undefined,
    phase: "dispatch_specialists",
    recon: {
      text: reconPack.text,
      hash: reconPack.hash,
      creditedLines: reconPack.creditedLines,
      promptCacheKey: reviewPromptCacheKey({
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha: checkpoint.headSha,
        reconPackHash: reconPack.hash,
      }),
    },
    specialistTiming: {
      deadlineAt: now + specialistsBudget,
      wrapUpAt: now + Math.min(REVIEW_SPECIALIST_WRAP_UP_MS, specialistsBudget),
    },
    progressRevision: 2,
  };
  if (brief === undefined)
    logWarn("review_brief_fallback", { owner: item.owner, repo: item.repo, pr: item.prNumber });
  await writeTick(live, finalized);
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "advance",
    checkpoint: finalized,
  });
}

export async function dispatchSpecialistsPhase(
  live: ReviewAttemptLive,
  entered: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  const checkpoint = await gateReviewPhase(live, entered);
  if (checkpoint.lifecycle.kind === "stopped")
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "advance",
      checkpoint: { ...checkpoint, phase: "publish" },
    });
  for (const specialist of SPECIALIST_IDS) {
    if (checkpoint.specialists[specialist].conversationId === undefined)
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "create_child",
        role: specialist,
        checkpoint,
      });
  }
  const lead = SPECIALIST_IDS[0];
  const now = io.now();
  if (checkpoint.specialists[lead].stage === "idle")
    return submitSpecialist(
      live,
      {
        ...checkpoint,
        phase: "wait_specialists",
        warmup: { released: false, releaseAt: now + SPECIALIST_WARMUP_LEAD_MAX_MS },
      },
      lead,
      "investigate",
      now,
    );
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "advance",
    checkpoint: { ...checkpoint, phase: "wait_specialists" },
  });
}

function settleSpecialist(
  checkpoint: ReviewAttemptCheckpoint,
  specialist: SpecialistId,
  outcome: StoredSpecialistOutcome,
) {
  const next = withTrack(checkpoint, specialist, { stage: "settled", outcome });
  return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({
    ...next,
    completionOrder: [...next.completionOrder.filter((id) => id !== specialist), specialist],
    progressRevision: nextProgressRevision(next.progressRevision),
  });
}

export async function waitSpecialistsPhase(
  live: ReviewAttemptLive,
  entered: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  let checkpoint = await gateReviewPhase(live, entered);
  const now = io.now();
  const timing = checkpoint.specialistTiming ?? { deadlineAt: now, wrapUpAt: now };
  const active = SPECIALIST_IDS.filter((id) => {
    const stage = checkpoint.specialists[id].stage;
    return stage === "investigating" || stage === "wrap_up" || stage === "repair";
  });
  if (checkpoint.lifecycle.kind !== "running" || now >= timing.deadlineAt) {
    for (const specialist of SPECIALIST_IDS) {
      const track = checkpoint.specialists[specialist];
      if (track.stage === "settled") continue;
      const report = track.stage === "idle" ? null : await recoverReport(live, io, specialist);
      checkpoint = settleSpecialist(
        checkpoint,
        specialist,
        report !== null
          ? { kind: "partial", report, durationMs: now - (track.startedAt ?? now) }
          : {
              kind: "failed",
              message: `${specialist} specialist did not finish before the deadline`,
              durationMs: now - (track.startedAt ?? now),
            },
      );
    }
    const next: ReviewAttemptCheckpoint = { ...checkpoint, phase: "synthesize_and_validate" };
    if (active.length > 0)
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "abort_children",
        roles: active,
        checkpoint: next,
      });
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({ kind: "advance", checkpoint: next });
  }
  if (!checkpoint.warmup.released) {
    const lead = SPECIALIST_IDS[0];
    const leadTrack = checkpoint.specialists[lead];
    const leadSettled =
      leadTrack.stage === "settled" ||
      (leadTrack.turnNo > 0 && (await io.settled(lead, leadTrack.turnNo - 1)).status !== "pending");
    if (leadSettled || now >= (checkpoint.warmup.releaseAt ?? now)) {
      const idle = SPECIALIST_IDS.find((id) => checkpoint.specialists[id].stage === "idle");
      if (idle !== undefined) return submitSpecialist(live, checkpoint, idle, "investigate", now);
      checkpoint = { ...checkpoint, warmup: { ...checkpoint.warmup, released: true } };
    }
  }
  let ticked = false;
  for (const specialist of SPECIALIST_IDS) {
    const track = checkpoint.specialists[specialist];
    if (track.stage === "idle" || track.stage === "settled") continue;
    const settled = await io.settled(specialist, track.turnNo - 1);
    if (settled.status === "pending") continue;
    const report = await recoverReport(live, io, specialist);
    const durationMs = now - (track.startedAt ?? now);
    if (report !== null) {
      const wrapped = track.stage !== "investigating" || now >= timing.wrapUpAt;
      checkpoint = settleSpecialist(checkpoint, specialist, {
        kind: wrapped ? "partial" : "complete",
        report,
        durationMs,
      });
      ticked = true;
      continue;
    }
    const aborted =
      settled.status === "unanswered" &&
      (settled.reason === "aborted" || settled.reason === "cancelled");
    const wrappedUp =
      now >= timing.wrapUpAt ||
      (settled.status === "unanswered" && settled.reason === "turn_limit");
    if (!aborted && track.stage === "investigating" && wrappedUp)
      return submitSpecialist(live, checkpoint, specialist, "wrap_up", now);
    if (
      !aborted &&
      settled.status === "unanswered" &&
      settled.reason !== "turn_limit" &&
      track.retries < 1
    )
      return submitSpecialist(
        live,
        withTrack(checkpoint, specialist, { retries: track.retries + 1 }),
        specialist,
        "investigate",
        now,
      );
    if (!aborted && track.repairs < VALIDATION_REPAIR_ROUNDS) {
      const state = live.submitStates.get(specialist);
      const validationError = state?.validationError ?? MISSING_REPORT_ERROR;
      if (state !== undefined) state.validationError = null;
      return submitSpecialist(live, checkpoint, specialist, "repair", now, validationError);
    }
    checkpoint = settleSpecialist(checkpoint, specialist, {
      kind: "failed",
      message:
        settled.status === "unanswered"
          ? `${specialist} specialist ended unanswered: ${settled.reason}`
          : `${specialist} specialist did not submit a valid report`,
      durationMs,
    });
    ticked = true;
  }
  if (ticked) await writeTick(live, checkpoint);
  const pending = SPECIALIST_IDS.filter((id) => {
    const stage = checkpoint.specialists[id].stage;
    return stage !== "settled";
  });
  if (pending.length === 0)
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "advance",
      checkpoint: { ...checkpoint, phase: "synthesize_and_validate" },
    });
  const waitFor = pending
    .filter((id) => checkpoint.specialists[id].stage !== "idle")
    .map((id) => ({ role: id, turnNo: checkpoint.specialists[id].turnNo - 1 }));
  const timers = [timing.deadlineAt];
  if (!checkpoint.warmup.released && checkpoint.warmup.releaseAt !== undefined)
    timers.push(checkpoint.warmup.releaseAt);
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "park",
    checkpoint,
    waitFor,
    until: Math.min(...timers),
  });
}

async function validateSettledReports(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  let next = checkpoint;
  const reader = live.env.repositoryView.workspace.reader;
  for (const specialist of SPECIALIST_IDS) {
    const outcome = next.specialists[specialist].outcome;
    if (outcome === undefined || outcome.kind === "failed") continue;
    const calls = await io.toolCalls(specialist, SUBMIT_FINDINGS_REPORT_NAME);
    const authoring = calls.toReversed().find((call) => acceptedResult(call.resultText));
    const ledger = live.setup.specialistLedgers[specialist];
    await io.creditEvidence(
      specialist,
      ledger,
      authoring?.assistantOrdinal ?? Number.MAX_SAFE_INTEGER,
    );
    const validated = assertFindingsHaveEvidence(outcome.report.findings, ledger, next.headSha, {
      checkoutCoverage: reader.getCoverage(),
      isPathInCheckout: (path) => reader.isPathInCheckout(path),
    });
    if (validated.rejected.length === 0) continue;
    const findings = validated.accepted;
    const report: SpecialistReport = {
      ...outcome.report,
      findings,
      status:
        findings.length === 0 && outcome.report.status === "findings"
          ? "no_findings"
          : outcome.report.status,
    };
    next = withTrack(next, specialist, { outcome: { ...outcome, report } });
  }
  return ((pinnedReturn: ReviewAttemptCheckpoint) => pinnedReturn)({ ...next, validated: true });
}

function judgeableSpecialists(checkpoint: ReviewAttemptCheckpoint) {
  return checkpoint.completionOrder.filter((specialist) => {
    const outcome = checkpoint.specialists[specialist].outcome;
    return (
      outcome !== undefined &&
      outcome.kind !== "failed" &&
      outcome.report.status === "findings" &&
      outcome.report.findings.length > 0
    );
  });
}

export async function synthesizeAndValidatePhase(
  live: ReviewAttemptLive,
  entered: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  let checkpoint = await gateReviewPhase(live, entered);
  if (checkpoint.lifecycle.kind === "stopped")
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "advance",
      checkpoint: { ...checkpoint, phase: "publish" },
    });
  if (!checkpoint.validated) {
    checkpoint = await validateSettledReports(live, checkpoint, io);
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({ kind: "advance", checkpoint });
  }
  const now = io.now();
  const inFlight = checkpoint.orchestrator.inFlight;
  if (inFlight !== undefined) {
    const settled = await io.settled("orchestrator", inFlight.turnNo);
    if (settled.status === "pending") {
      if (now < checkpoint.timing.modelStopAt && checkpoint.lifecycle.kind === "running")
        return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
          kind: "park",
          checkpoint,
          waitFor: [{ role: "orchestrator", turnNo: inFlight.turnNo }],
          until: checkpoint.timing.modelStopAt,
        });
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "abort_children",
        roles: ["orchestrator"],
        checkpoint: {
          ...withOrchestrator(checkpoint, { retired: true, inFlight: undefined }),
          judgment: "degraded",
          unjudged:
            inFlight.step === "judgment" && inFlight.specialist !== undefined
              ? [...checkpoint.unjudged, inFlight.specialist]
              : checkpoint.unjudged,
          judged:
            inFlight.step === "judgment" && inFlight.specialist !== undefined
              ? [...checkpoint.judged, inFlight.specialist]
              : checkpoint.judged,
        },
      });
    }
    const ledger = live.publishThread.getLedger();
    let next: ReviewAttemptCheckpoint = {
      ...withOrchestrator(checkpoint, { inFlight: undefined }),
      ledger,
      summary: {
        published:
          live.summaryState.published ||
          workPublishRecord(live.env.db, live.env.item.id, "summary_comment") !== undefined,
        check: live.summaryState.check ?? checkpoint.summary.check,
      },
    };
    if (settled.status === "unanswered") next = { ...next, judgment: "degraded" };
    if (inFlight.step === "judgment" && inFlight.specialist !== undefined) {
      const unpublished = ledger.threadCallCount === (inFlight.threadCallsBefore ?? -1);
      next = {
        ...next,
        judged: [...next.judged, inFlight.specialist],
        unjudged: unpublished ? [...next.unjudged, inFlight.specialist] : next.unjudged,
        progressRevision: nextProgressRevision(next.progressRevision),
      };
      await writeTick(live, next);
    }
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({ kind: "advance", checkpoint: next });
  }
  const pendingJudgment = judgeableSpecialists(checkpoint).find(
    (specialist) => !checkpoint.judged.includes(specialist),
  );
  const orchestratorAvailable =
    checkpoint.orchestrator.conversationId !== undefined &&
    !checkpoint.orchestrator.retired &&
    checkpoint.lifecycle.kind === "running";
  const step = nextSynthesisStep({
    pendingJudgment: pendingJudgment !== undefined,
    orchestratorAvailable,
    summaryPublished: checkpoint.summary.published || live.summaryState.published,
    synthesisSent: checkpoint.orchestrator.synthesisSent,
    repairsUsed: checkpoint.orchestrator.repairs,
    repairLimit: VALIDATION_REPAIR_ROUNDS * 2,
    recoveriesUsed: checkpoint.orchestrator.recoveries,
    recoveryLimit: PUBLISH_RECOVERY_ROUNDS,
  });
  switch (step) {
    case "judge": {
      if (pendingJudgment === undefined) break;
      const outcome = checkpoint.specialists[pendingJudgment].outcome;
      if (outcome === undefined || outcome.kind === "failed") break;
      live.publishThread.setSource(pendingJudgment);
      live.publishThread.setReport(outcome.report);
      live.phaseRef.current = "judgment";
      const ledgerBefore = live.publishThread.getLedger();
      const judged = outcomeOf(pendingJudgment, outcome);
      if (judged.kind === "failed") break;
      return orchestratorTurn(
        checkpoint,
        "judgment",
        renderJudgmentTurn(
          judged,
          slimAcceptedFindings(judged, ledgerBefore),
          judgmentInventory(live.inventory, outcome.report.findings, ledgerBefore.accepted),
        ),
        {
          maxToolRounds: escalatedToolRounds(
            ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
            live.escalation,
          ),
          reservedTerminalTool: "publish_thread",
        },
        { specialist: pendingJudgment, threadCallsBefore: ledgerBefore.threadCallCount },
      );
    }
    case "unjudged": {
      const remaining = judgeableSpecialists(checkpoint).filter(
        (specialist) => !checkpoint.judged.includes(specialist),
      );
      return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
        kind: "advance",
        checkpoint: {
          ...checkpoint,
          judgment: "degraded",
          judged: [...checkpoint.judged, ...remaining],
          unjudged: [...checkpoint.unjudged, ...remaining],
        },
      });
    }
    case "synthesis": {
      live.phaseRef.current = "synthesis";
      return orchestratorTurn(
        withOrchestrator(checkpoint, { synthesisSent: true }),
        "synthesis",
        renderSynthesisTurn({
          acceptedFindings: live.publishThread.getLedger().accepted,
          partialSpecialists: SPECIALIST_IDS.filter((specialist) => {
            const kind = checkpoint.specialists[specialist].outcome?.kind;
            return kind === "failed" || kind === "partial";
          }),
          outcomes: checkpoint.completionOrder.flatMap((specialist) => {
            const stored = checkpoint.specialists[specialist].outcome;
            return stored === undefined ? [] : [outcomeOf(specialist, stored)];
          }),
        }),
        { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
      );
    }
    case "repair_summary": {
      live.phaseRef.current = "synthesis";
      const validationError =
        live.summaryState.lastValidationError ?? ORCHESTRATOR_MISSING_SUMMARY_ERROR;
      live.summaryState.lastValidationError = null;
      return orchestratorTurn(
        withOrchestrator(checkpoint, { repairs: checkpoint.orchestrator.repairs + 1 }),
        "repair_summary",
        renderOrchestratorSummaryRepair(validationError),
        { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
      );
    }
    case "recover_summary": {
      live.phaseRef.current = "synthesis";
      return orchestratorTurn(
        withOrchestrator(checkpoint, { recoveries: checkpoint.orchestrator.recoveries + 1 }),
        "recover_summary",
        ORCHESTRATOR_RECOVER_SUMMARY_INSTRUCTION,
        { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
      );
    }
    case "publish":
      break;
    default: {
      const exhaustive: never = step;
      void exhaustive;
    }
  }
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "advance",
    checkpoint: { ...checkpoint, phase: "publish" },
  });
}

export async function publishPhase(live: ReviewAttemptLive, checkpoint: ReviewAttemptCheckpoint) {
  const env = live.env;
  const item = env.item;
  const verdict = reviewVerdictSurfaces({
    target: { ...env.target, gate: "cleanup" },
    prSurface: live.setup.prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    reviewLens: item.reviewLens,
    headSha: checkpoint.headSha,
    commitStatusEnabled: env.cfg.features.commitStatus,
  });
  if (checkpoint.lifecycle.kind === "stopped") {
    const reason = checkpoint.lifecycle.reason;
    const terminal = { ...checkpoint, progressRevision: 7 as const };
    const attribution = cancelAttributionFor(env.db, item.id);
    if (reason === "cancelled" && attribution !== undefined) {
      await writeCancelledProgressComment({
        coordination: { ...env.target, gate: "cleanup" },
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        mode: item.reviewLens,
        attribution,
        prSurface: live.setup.prSurface,
      });
    } else {
      await tickProgressComment({
        coordination: { ...env.target, gate: "cleanup" },
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        mode: item.reviewLens,
        headSha: checkpoint.headSha,
        source: item.source,
        progressRevision: 7,
        tickState: {
          kind: "terminal",
          reason: reason === "stale_head" ? "stale_head" : "superseded",
          recon: checkpoint.brief !== undefined ? "done" : "running",
          specialists: specialistPhases(checkpoint),
        },
        prSurface: live.setup.prSurface,
        headCi: env.headCi,
      });
    }
    await verdict.close({
      kind:
        reason === "stale_head"
          ? "stale_head"
          : reason === "cancelled"
            ? "cancelled"
            : "superseded",
    });
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "finish",
      checkpoint: terminal,
      result: { status: "cancelled", reason },
    });
  }
  const published =
    checkpoint.summary.published ||
    live.summaryState.published ||
    workPublishRecord(env.db, item.id, "summary_comment") !== undefined;
  if (published)
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "finish",
      checkpoint: { ...checkpoint, summary: { ...checkpoint.summary, published: true } },
      result: { status: "completed", published: true },
    });
  const allFailed = SPECIALIST_IDS.every(
    (specialist) => checkpoint.specialists[specialist].outcome?.kind === "failed",
  );
  if (allFailed) {
    await publishReviewRunFailureNotice({
      cfg: env.cfg,
      setup: live.setup,
      summaryCoordination: env.target,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      reviewMode: item.reviewLens,
      publishAttempts: 0,
      findingView: buildFindingView(
        live.inventory,
        { kind: "not_reviewed" },
        env.cfg.review.checkFailSeverity,
      ),
    });
    await verdict.close({ kind: "not_published" });
    return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
      kind: "finish",
      checkpoint,
      result: { status: "completed", published: false },
    });
  }
  const ledger = live.publishThread.getLedger();
  const result = await publishReviewSummaryOnly(live.session, {
    payload: reviewPayloadFromFindings(ledgerFindings(ledger)),
    ledger,
    coverage: coverageFor(live, checkpoint),
  });
  return ((pinnedReturn: ReviewPhaseStep) => pinnedReturn)({
    kind: "finish",
    checkpoint: {
      ...checkpoint,
      ledger,
      summary: {
        published: result.kind === "published",
        check: result.kind === "published" ? result.check : null,
      },
    },
    result:
      result.kind === "published"
        ? { status: "completed", published: true }
        : { status: "cancelled", reason: result.reason },
  });
}

export async function runReviewPhase(
  live: ReviewAttemptLive,
  checkpoint: ReviewAttemptCheckpoint,
  io: ReviewTurnReader,
) {
  switch (checkpoint.phase) {
    case "recon":
      return reconPhase(live, checkpoint, io);
    case "dispatch_specialists":
      return dispatchSpecialistsPhase(live, checkpoint, io);
    case "wait_specialists":
      return waitSpecialistsPhase(live, checkpoint, io);
    case "synthesize_and_validate":
      return synthesizeAndValidatePhase(live, checkpoint, io);
    case "publish":
      return publishPhase(live, checkpoint);
    default: {
      const exhaustive: never = checkpoint.phase;
      throw new Error(`unknown review phase ${String(exhaustive)}`);
    }
  }
}

export function freshEvidenceLedger(headSha: string) {
  return createEvidenceLedger(headSha);
}

export const OPENED_PATH_LIMIT = OPENED_PATH_MAX_CHARS;
export const UNREAD_NOTE = unreadChangedFilesNote;
export function fallbackBrief(changedPaths: readonly string[]) {
  const files = [...changedPaths];
  const riskFiles = files.slice(0, 12);
  return ((pinnedReturn: SpecialistBrief) => pinnedReturn)({
    prIntent:
      "Reconnaissance did not produce a valid structured brief. Pull request metadata is provided separately as untrusted evidence.",
    architectureNotes: "Reconnaissance did not produce a valid structured brief.",
    riskAreas: riskFiles.map((file) => ({
      area: file.slice(0, 200),
      files: [file],
      reason: "Changed file requires specialist inspection.",
    })),
    fileMap: files.length > 0 ? files.join("\n").slice(0, 6000) : "No changed files were listed.",
    specialistFocus: {
      correctness: "Check behavior, state transitions, and error handling.",
      security: "Check trust boundaries, authorization, and sensitive data handling.",
      quality: "Check maintainability, module ownership, and avoidable complexity.",
      tests: "Check regression coverage and missing failure-path tests.",
    },
  });
}

export function reviewRunCoverage(
  failedSpecialists: readonly SpecialistId[],
  unreadPaths: readonly string[],
  unjudgedSpecialists: readonly SpecialistId[] = [],
  partialSpecialists: readonly SpecialistId[] = [],
) {
  const failed = [...failedSpecialists];
  if (failed.length === SPECIALIST_IDS.length)
    return ((pinnedReturn: ReviewCoverage) => pinnedReturn)({ kind: "none", failed });
  const paths: string[] = [];
  for (const path of unreadPaths) {
    const bounded = path.slice(0, OPENED_PATH_MAX_CHARS);
    if (bounded.length === 0) continue;
    paths.push(bounded);
    if (paths.length === UNREAD_COVERAGE_PATH_LIMIT) break;
  }
  const unjudged = [...unjudgedSpecialists];
  const partial = partialSpecialists.filter((specialist) => !failed.includes(specialist));
  if (failed.length === 0 && paths.length === 0 && unjudged.length === 0 && partial.length === 0)
    return ((pinnedReturn: ReviewCoverage) => pinnedReturn)({ kind: "full" });
  const sentences: string[] = [];
  if (failed.length > 0) {
    const names = failed.join(", ");
    sentences.push(
      `Coverage partial: ${names} specialist${failed.length === 1 ? "" : "s"} failed.`,
    );
  }
  if (partial.length > 0) {
    const names = partial.join(", ");
    sentences.push(
      `Coverage partial: ${names} specialist${partial.length === 1 ? "" : "s"} wrapped up before finishing their pass.`,
    );
  }
  if (paths.length > 0) sentences.push(unreadChangedFilesNote(unreadPaths));
  if (unjudged.length > 0) sentences.push(`Not judged: ${unjudged.join(", ")}.`);
  return ((pinnedReturn: ReviewCoverage) => pinnedReturn)({
    kind: "partial",
    note: sentences.join(" "),
    ...(failed.length > 0 ? { failed } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(unjudged.length > 0 ? { unjudged } : {}),
    ...(partial.length > 0 ? { partial } : {}),
  });
}

export function nextProgressRevision(revision: OrchestratedRunState["progressRevision"]) {
  switch (revision) {
    case 0:
    case 1:
    case 2:
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(3);
    case 3:
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(4);
    case 4:
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(5);
    case 5:
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(6);
    case 6:
    case 7:
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(6);
    default: {
      const exhaustive: never = revision;
      return ((pinnedReturn: 3 | 4 | 5 | 6) => pinnedReturn)(exhaustive);
    }
  }
}

export function acceptedOpenThreads(ledger: FindingLedger) {
  return ((pinnedReturn: AcceptedOpenThread[]) => pinnedReturn)(
    ledger.accepted.flatMap((accepted) =>
      accepted.kind === "summary_only"
        ? []
        : [
            {
              id: accepted.findingId,
              path: accepted.placement.finding.file,
              startLine: accepted.placement.finding.startLine,
              endLine: accepted.placement.finding.endLine,
              title: accepted.placement.finding.title,
              detail: accepted.placement.finding.detail,
              severity: accepted.placement.finding.severity,
              lens: accepted.source,
            },
          ],
    ),
  );
}
