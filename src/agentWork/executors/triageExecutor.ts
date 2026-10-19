import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.ts";
import { productionInstallationSurface } from "../installationSurface.ts";
import { createPublishContext } from "../publishOnce.ts";
import type { Pool } from "pg";

import {
  type Config,
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_BULK_PREVIEW_STALE,
  TRIAGE_BULK_REQUIRES_PREVIEW,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_FORK_PR_NOTICE,
  TRIAGE_NO_ELIGIBLE_FINDINGS,
  TRIAGE_PUBLISH_LENS,
  TRIAGE_THREAD_NOT_ELIGIBLE,
  TRIAGE_SUMMARY_SENTINEL,
} from "../../settings/index.ts";
import { AppError } from "../../errors/appError.ts";
import { logWarn } from "../../evlog.ts";
import type { BotIdentity } from "../../github/appAuth.ts";
import { pullRequestBranchInfo } from "../../github/listPullRequestFiles.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.ts";
import { warnReviewThreadResolutionDegraded } from "../../github/reviewThreadResolution.ts";
import {
  fetchBotFindingThreads,
  resolveReviewThreadRootId,
  type BotFindingThread,
} from "../../review/run/reviewPriorFeedback.ts";
import { loadFindingInventoryFromThreads } from "../../review/findingIdentity/findingInventory.ts";
import { runFullPrTriage } from "../../agent/triage/triageRun.ts";
import {
  previewApprovalSets,
  remapBulkPayload,
  replayPreviewHunks,
} from "../../agent/triage/previewApproval.ts";
import {
  assertTriagePullRequestWritable,
  TriageCancelledError,
  TriageClosedPullRequestError,
} from "../../agent/triage/triageErrors.ts";
import {
  parseStoredTriagePreviewDetail,
  recoverTriagePublication,
  publishTriage,
  publishTriagePreview,
  publishTriageReportOnly,
  type PublishTriageResult,
  type StoredTriagePreviewDetail,
} from "../../agent/triage/publishTriage.ts";
import { withWritablePrCheckout } from "../../prWorkspace/writablePrCheckout.ts";
import {
  buildTriageCommitAttribution,
  gitPersonFromGithubUser,
  type GitPerson,
} from "../../agent/triage/commitAttribution.ts";
import { listTriageEligibleInlineReviews } from "../publishRecordRepository.ts";
import { type DurableExecutionContext, type DurableExecutionResult } from "../durableJob.ts";
import type { EscalationPlan } from "../retryPolicy.ts";
import { triageMode, type TriageWorkPayload, type AgentWorkItem } from "../types.ts";
import { toError } from "../../errors/errorMessage.ts";

type TriageWorkItem = Extract<AgentWorkItem, { type: "triage" }>;

type TriageDegradationReason =
  | "push_stale"
  | "push_closed"
  | "thread_action_missing"
  | "bulk_partial"
  | "replay_commit_errors";

type TriageExecuteResult = Extract<DurableExecutionResult, { kind: "completed" }>;

type EmptyInventoryOutcome = "all_resolved" | "thread_not_eligible" | "no_eligible_findings";

const EMPTY_INVENTORY_MESSAGES: Record<EmptyInventoryOutcome, string> = {
  all_resolved: TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  thread_not_eligible: TRIAGE_THREAD_NOT_ELIGIBLE,
  no_eligible_findings: TRIAGE_NO_ELIGIBLE_FINDINGS,
};

type TriageReportContext = {
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly threadRootCommentId: number | undefined;
};

type InventoryAndScope = {
  readonly botIdentity: BotIdentity;
  readonly threads: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly inventory: readonly BotFindingThread[];
  readonly scopedThreadRootId: number | undefined;
  readonly reportContext: TriageReportContext;
};

function reportOnlyBody(params: {
  readonly message: string;
  readonly headSha: string;
  readonly inventoryCount: number;
  readonly previouslyResolvedCount: number;
  readonly scope: TriageWorkPayload["scope"];
  readonly threadRootCommentId?: number;
}): string {
  const lines = [
    TRIAGE_SUMMARY_SENTINEL,
    "",
    params.scope === "thread" ? "Scoped to 1 finding." : "Full PR triage.",
  ];
  if (params.threadRootCommentId != null) {
    lines.push(`Thread root: \`${params.threadRootCommentId}\``);
  }
  lines.push(
    "",
    params.message,
    "",
    `Evaluated head: \`${params.headSha}\``,
    `Inventory items: ${params.inventoryCount}`,
    `Previously resolved: ${params.previouslyResolvedCount}`,
  );
  return lines.join("\n");
}

function triageReportContext(
  payload: TriageWorkPayload,
  threadRootCommentId?: number,
): TriageReportContext {
  return {
    scope: payload.scope ?? "all",
    threadRootCommentId: payload.scope === "thread" ? threadRootCommentId : undefined,
  };
}

async function resolveScopedThreadRootId(params: {
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly anchorCommentId: number;
}): Promise<number> {
  try {
    const { comments } = await params.prSurface.listReviewComments();
    return resolveReviewThreadRootId(comments, params.anchorCommentId) ?? params.anchorCommentId;
  } catch (error) {
    const errorObj = toError(error);
    logWarn("triage_thread_root_resolution_failed", {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      anchorCommentId: params.anchorCommentId,
      message: errorObj.message,
    });
    return params.anchorCommentId;
  }
}

function completedFromPublish(publish: PublishTriageResult): TriageExecuteResult {
  const reasons: TriageDegradationReason[] = [];
  if (publish.pushOutcome === "stale") reasons.push("push_stale");
  if (publish.pushOutcome === "closed") reasons.push("push_closed");
  if (publish.missingThreadAction) reasons.push("thread_action_missing");
  if (publish.partialBulk === true) reasons.push("bulk_partial");
  return reasons.length === 0 ? { kind: "completed" } : { kind: "completed", degradation: reasons };
}

async function ensureTriageNotCancelled(env: DurableExecutionContext): Promise<void> {
  if (await env.shouldAbortPublish()) throw new TriageCancelledError();
}

async function ensureTriageWriteAllowed(params: {
  readonly env: DurableExecutionContext;
  readonly prSurface: PrSurface;
}): Promise<void> {
  await ensureTriageNotCancelled(params.env);
  await assertTriagePullRequestWritable(params.prSurface);
}

function resolveEmptyInventoryOutcome(params: {
  readonly scope: TriageWorkPayload["scope"];
  readonly scopedThreadRootId: number | undefined;
  readonly threads: readonly BotFindingThread[];
}): EmptyInventoryOutcome {
  if (params.scope === "thread") {
    const threadMatchesKnownFinding =
      params.scopedThreadRootId != null &&
      params.threads.some((thread) => thread.rootCommentId === params.scopedThreadRootId);
    return threadMatchesKnownFinding ? "all_resolved" : "thread_not_eligible";
  }
  return params.threads.length === 0 ? "no_eligible_findings" : "all_resolved";
}

async function handleForkPrReport(params: {
  readonly env: DurableExecutionContext;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly leaseEpoch: number | null;
}): Promise<TriageExecuteResult> {
  await ensureTriageNotCancelled(params.env);
  await publishTriageReportOnly({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: [],
    previouslyResolvedCount: 0,
    leaseEpoch: params.leaseEpoch,
    body: reportOnlyBody({
      message: TRIAGE_FORK_PR_NOTICE,
      headSha: params.headSha,
      inventoryCount: 0,
      previouslyResolvedCount: 0,
      scope: params.scope,
    }),
  });
  return { kind: "completed" };
}

async function resolveInventoryAndScope(params: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
}): Promise<InventoryAndScope> {
  const payload = params.item.payload;
  const botIdentity = await params.getBotIdentity();
  const eligibleReviews = await listTriageEligibleInlineReviews(
    params.pool,
    params.item.resourceKey,
  );
  const resolutionResult = await params.prSurface.listInlineReviewThreads();
  const findingInventory = await loadFindingInventoryFromThreads(params.prSurface, {
    threads: resolutionResult,
    botLogin: botIdentity.login,
    renames: new Map(),
    deletedPaths: new Set(),
  });
  const threads = (
    await fetchBotFindingThreads(params.prSurface, {
      botUserId: botIdentity.userId,
      botLogin: botIdentity.login,
      inventory: findingInventory,
      publishRecordLenses: eligibleReviews,
      maintainerDecisionAssociations: params.cfg.associations.maintainerDecision,
    })
  ).threads;
  warnReviewThreadResolutionDegraded(resolutionResult, {
    type: "triage",
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    owner: params.item.owner,
    repo: params.item.repo,
    pr: params.item.prNumber,
  });
  const resolutionByRootCommentId = resolutionResult.byRootCommentId;
  const previouslyResolvedCount = threads.filter(
    (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved === true,
  ).length;
  const allUnresolved = threads.filter(
    (thread) => resolutionByRootCommentId.get(thread.rootCommentId)?.isResolved !== true,
  );
  let scopedThreadRootId: number | undefined;
  let inventory = allUnresolved;
  if (params.scope === "thread") {
    if (payload.threadAnchorCommentId != null) {
      scopedThreadRootId =
        payload.needsThreadRootResolution === true
          ? await resolveScopedThreadRootId({
              prSurface: params.prSurface,
              owner: params.item.owner,
              repo: params.item.repo,
              prNumber: params.item.prNumber,
              anchorCommentId: payload.threadAnchorCommentId,
            })
          : payload.threadAnchorCommentId;
      inventory =
        scopedThreadRootId != null
          ? allUnresolved.filter((thread) => thread.rootCommentId === scopedThreadRootId)
          : [];
    } else {
      inventory = [];
    }
  }
  return {
    botIdentity,
    threads,
    resolutionByRootCommentId,
    previouslyResolvedCount,
    inventory,
    scopedThreadRootId,
    reportContext: triageReportContext(payload, scopedThreadRootId),
  };
}

async function publishEmptyInventoryReport(params: {
  readonly env: DurableExecutionContext;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly threads: readonly BotFindingThread[];
  readonly inventory: readonly BotFindingThread[];
  readonly previouslyResolvedCount: number;
  readonly scopedThreadRootId: number | undefined;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
}): Promise<TriageExecuteResult> {
  await ensureTriageNotCancelled(params.env);
  const outcome = resolveEmptyInventoryOutcome({
    scope: params.scope,
    scopedThreadRootId: params.scopedThreadRootId,
    threads: params.threads,
  });
  const message = EMPTY_INVENTORY_MESSAGES[outcome];
  await publishTriageReportOnly({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    inventory: params.inventory,
    previouslyResolvedCount: params.previouslyResolvedCount,
    leaseEpoch: params.leaseEpoch,
    ...params.reportContext,
    body: reportOnlyBody({
      message,
      headSha: params.headSha,
      inventoryCount: params.scope === "thread" ? params.inventory.length : params.threads.length,
      previouslyResolvedCount: params.previouslyResolvedCount,
      scope: params.scope,
      threadRootCommentId: params.scopedThreadRootId,
    }),
  });
  return { kind: "completed" };
}

async function tryResumeStoredPush(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly inventory: readonly BotFindingThread[];
  readonly recoveryInventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
}): Promise<TriageExecuteResult | null> {
  const publish = await recoverTriagePublication({
    pool: params.pool,
    workItemId: params.item.id,
    resourceKey: params.item.resourceKey,
    installationId: params.item.installationId,
    prSurface: params.prSurface,
    owner: params.item.owner,
    repo: params.item.repo,
    prNumber: params.item.prNumber,
    headSha: params.headSha,
    headRef: params.headRef,
    inventory: params.inventory,
    recoveryInventory: params.recoveryInventory,
    resolutionByRootCommentId: params.resolutionByRootCommentId,
    previouslyResolvedCount: params.previouslyResolvedCount,
    leaseEpoch: params.leaseEpoch,
    signal: params.signal,
    ...params.reportContext,
  });
  if (publish == null) return null;
  return completedFromPublish(publish);
}

async function resolveTriggererGitPerson(params: {
  readonly prSurface: PrSurface;
  readonly commenterId?: number;
  readonly botIdentity: BotIdentity;
}): Promise<GitPerson | null> {
  if (params.commenterId == null) return null;
  if (params.commenterId === params.botIdentity.userId) return null;
  try {
    const data = await params.prSurface.lookupGitHubUser(params.commenterId);
    if (data == null) return null;
    return gitPersonFromGithubUser(data);
  } catch (error) {
    const errorObj = toError(error);
    logWarn("triage_commit_identity_lookup_failed", {
      commenterId: params.commenterId,
      message: errorObj.message,
    });
    return null;
  }
}

async function runFreshTriageAgent(params: {
  readonly env: DurableExecutionContext;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly botIdentity: BotIdentity;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
  readonly mode: "apply" | "preview";
  readonly escalation?: EscalationPlan;
}): Promise<TriageExecuteResult> {
  const triggerer = await resolveTriggererGitPerson({
    prSurface: params.prSurface,
    commenterId: params.item.payload.commenterId,
    botIdentity: params.botIdentity,
  });
  const commitAttribution = buildTriageCommitAttribution({
    botIdentity: params.botIdentity,
    triggerer,
  });
  const { token } = await params.prSurface.gitCredentialAuth();
  const preview = params.mode === "preview";
  return withWritablePrCheckout(
    {
      owner: params.item.owner,
      repo: params.item.repo,
      headRef: params.headRef,
      headSha: params.headSha,
      installationToken: token,
      botIdentity: params.botIdentity,
      commitAttribution,
      beforeCommit: preview
        ? () => ensureTriageNotCancelled(params.env)
        : () =>
            ensureTriageWriteAllowed({
              env: params.env,
              prSurface: params.prSurface,
            }),
      beforePush: preview
        ? async () => {
            throw new AppError({
              domain: "triage",
              kind: "preview_push_blocked",
              message: "Triage preview cannot push",
            });
          }
        : () =>
            ensureTriageWriteAllowed({
              env: params.env,
              prSurface: params.prSurface,
            }),
    },
    async (checkout) => {
      let result: Awaited<ReturnType<typeof runFullPrTriage>>;
      try {
        result = await runFullPrTriage({
          cfg: params.cfg,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          checkout,
          inventory: params.inventory,
          cwd: checkout.dir,
          scope: params.scope,
          refreshBeforeTool: async () => ensureTriageNotCancelled(params.env),
          escalation: params.escalation,
          sessionContext: params.env.durability,
          signal: params.signal,
        });
      } catch (error) {
        if (!(error instanceof TriageClosedPullRequestError)) throw error;
        await publishTriageReportOnly({
          pool: params.pool,
          workItemId: params.item.id,
          resourceKey: params.item.resourceKey,
          installationId: params.item.installationId,
          prSurface: params.prSurface,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          inventory: params.inventory,
          previouslyResolvedCount: params.previouslyResolvedCount,
          leaseEpoch: params.leaseEpoch,
          ...params.reportContext,
          body: reportOnlyBody({
            message: TRIAGE_CLOSED_PR_NOTICE,
            headSha: params.headSha,
            inventoryCount: params.inventory.length,
            previouslyResolvedCount: params.previouslyResolvedCount,
            scope: params.scope,
            threadRootCommentId: params.reportContext.threadRootCommentId,
          }),
        });
        return {
          kind: "completed",
          degradation: ["push_closed"] satisfies readonly TriageDegradationReason[],
        };
      }
      await ensureTriageNotCancelled(params.env);
      const commitByThreadRootCommentId = result.commitByThreadRootCommentId ?? new Map();
      if (!result.submitted || !result.payload) {
        const error = new AppError({
          domain: "triage",
          kind: "missing_submit",
          message: "Triage run ended without submitTriage",
        });
        throw error;
      }
      if (preview) {
        const detailBySha = new Map(
          checkout.listCommittedDetails().map((commit) => [commit.sha.toLowerCase(), commit]),
        );
        const hunks = [...commitByThreadRootCommentId.entries()].flatMap(
          ([threadRootCommentId, sha]) => {
            const detail = detailBySha.get(sha.toLowerCase());
            return detail == null
              ? []
              : [
                  {
                    threadRootCommentId,
                    subject: detail.subject,
                    diff: detail.diff,
                  },
                ];
          },
        );
        await publishTriagePreview({
          pool: params.pool,
          workItemId: params.item.id,
          resourceKey: params.item.resourceKey,
          installationId: params.item.installationId,
          prSurface: params.prSurface,
          owner: params.item.owner,
          repo: params.item.repo,
          prNumber: params.item.prNumber,
          headSha: params.headSha,
          inventory: params.inventory,
          previouslyResolvedCount: params.previouslyResolvedCount,
          leaseEpoch: params.leaseEpoch,
          hunks,
          payload: result.payload,
          ...params.reportContext,
        });
        return { kind: "completed" };
      }
      const publish = await publishTriage({
        pool: params.pool,
        workItemId: params.item.id,
        resourceKey: params.item.resourceKey,
        installationId: params.item.installationId,
        prSurface: params.prSurface,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        resolutionByRootCommentId: params.resolutionByRootCommentId,
        payload: result.payload,
        previouslyResolvedCount: params.previouslyResolvedCount,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        ...params.reportContext,
      });
      const completed = completedFromPublish(publish);
      if (completed.degradation != null) {
      } else {
      }
      return completed;
    },
  );
}

async function runBulkFromPreview(params: {
  readonly env: DurableExecutionContext;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: TriageWorkItem;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly headRef: string;
  readonly botIdentity: BotIdentity;
  readonly scope: NonNullable<TriageWorkPayload["scope"]> | "all";
  readonly inventory: readonly BotFindingThread[];
  readonly approvedHunks: readonly {
    readonly threadRootCommentId: number;
    readonly subject: string;
    readonly diff: string;
  }[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly previouslyResolvedCount: number;
  readonly reportContext: TriageReportContext;
  readonly leaseEpoch: number | null;
  readonly signal: AbortSignal;
  readonly preview: StoredTriagePreviewDetail;
  readonly approvedIds: ReadonlySet<number>;
  readonly excludedIds: ReadonlySet<number>;
  readonly notInPreviewIds: ReadonlySet<number>;
}): Promise<TriageExecuteResult> {
  const triggerer = await resolveTriggererGitPerson({
    prSurface: params.prSurface,
    commenterId: params.item.payload.commenterId,
    botIdentity: params.botIdentity,
  });
  const commitAttribution = buildTriageCommitAttribution({
    botIdentity: params.botIdentity,
    triggerer,
  });
  const { token } = await params.prSurface.gitCredentialAuth();
  return withWritablePrCheckout(
    {
      owner: params.item.owner,
      repo: params.item.repo,
      headRef: params.headRef,
      headSha: params.headSha,
      installationToken: token,
      botIdentity: params.botIdentity,
      commitAttribution,
      beforeCommit: () =>
        ensureTriageWriteAllowed({
          env: params.env,
          prSurface: params.prSurface,
        }),
      beforePush: () =>
        ensureTriageWriteAllowed({
          env: params.env,
          prSurface: params.prSurface,
        }),
    },
    async (checkout) => {
      const replayed = await replayPreviewHunks({
        checkout,
        hunks: params.approvedHunks,
      });
      const payload = remapBulkPayload({
        payload: params.preview.payload,
        approvedIds: params.approvedIds,
        appliedCommits: replayed.commitByThreadRootCommentId,
      });
      await ensureTriageNotCancelled(params.env);
      const publish = await publishTriage({
        pool: params.pool,
        workItemId: params.item.id,
        resourceKey: params.item.resourceKey,
        installationId: params.item.installationId,
        prSurface: params.prSurface,
        owner: params.item.owner,
        repo: params.item.repo,
        prNumber: params.item.prNumber,
        headSha: params.headSha,
        checkout,
        inventory: params.inventory,
        resolutionByRootCommentId: params.resolutionByRootCommentId,
        payload,
        previouslyResolvedCount: params.previouslyResolvedCount,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        bulkClassification: {
          excludedIds: params.excludedIds,
          notInPreviewIds: params.notInPreviewIds,
          commitByThreadRootCommentId: replayed.commitByThreadRootCommentId,
          commitErrors: replayed.commitErrors,
        },
        ...params.reportContext,
      });
      const completed = completedFromPublish(publish);
      const replayDegradation: readonly TriageDegradationReason[] =
        replayed.commitErrors.length > 0 ? ["replay_commit_errors"] : [];
      if (replayDegradation.length > 0 || publish.partialBulk === true) {
        return {
          kind: "completed",
          degradation: [...(completed.degradation ?? []), ...replayDegradation],
        };
      }
      return completed;
    },
  );
}

export function createTriageWorkExecution({
  cfg,
  pool,
  installationSurface = productionInstallationSurface,
}: WorkExecutionDependencies): WorkExecution<"triage"> {
  const getBotIdentity = () => installationSurface.botIdentity(cfg);
  return {
    execute: async (item, env) => {
      let omitTerminal = false;
      const result = await (async (): Promise<TriageExecuteResult> => {
        const scope = item.payload.scope ?? "all";
        const mode = triageMode(item.payload);
        const { prSurface } = env;
        const headSha = env.headSha;
        await ensureTriageNotCancelled(env);
        const branch = pullRequestBranchInfo((await prSurface.getHead()).pullRequest);
        await ensureTriageNotCancelled(env);
        if (!branch.sameRepo && mode !== "preview") {
          return handleForkPrReport({
            env,
            pool,
            item,
            prSurface,
            headSha,
            scope,
            leaseEpoch: env.leaseEpoch,
          });
        }

        let storedPreview: StoredTriagePreviewDetail | null = null;
        if (mode === "bulk") {
          storedPreview = parseStoredTriagePreviewDetail(
            await createPublishContext(pool, {
              resourceKey: item.resourceKey,
              reviewLens: TRIAGE_PUBLISH_LENS,
            }).latest("triage_preview"),
          );
          if (storedPreview == null) {
            await publishTriageReportOnly({
              pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              installationId: item.installationId,
              prSurface,
              owner: item.owner,
              repo: item.repo,
              prNumber: item.prNumber,
              headSha,
              inventory: [],
              previouslyResolvedCount: 0,
              leaseEpoch: env.leaseEpoch,
              body: reportOnlyBody({
                message: TRIAGE_BULK_REQUIRES_PREVIEW,
                headSha,
                inventoryCount: 0,
                previouslyResolvedCount: 0,
                scope,
              }),
            });
            return { kind: "completed" };
          }
          if (storedPreview.headSha.toLowerCase() !== headSha.toLowerCase()) {
            await publishTriageReportOnly({
              pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              installationId: item.installationId,
              prSurface,
              owner: item.owner,
              repo: item.repo,
              prNumber: item.prNumber,
              headSha,
              inventory: [],
              previouslyResolvedCount: 0,
              leaseEpoch: env.leaseEpoch,
              body: reportOnlyBody({
                message: TRIAGE_BULK_PREVIEW_STALE,
                headSha,
                inventoryCount: 0,
                previouslyResolvedCount: 0,
                scope,
              }),
            });
            return { kind: "completed" };
          }
        }

        const discovered = await resolveInventoryAndScope({
          getBotIdentity,
          cfg,
          pool,
          item,
          prSurface,
          scope,
        });
        await ensureTriageNotCancelled(env);

        const currentInventory = discovered.inventory;
        const excludeIds = new Set(item.payload.excludeThreadRootCommentIds ?? []);
        const approval =
          mode === "bulk" && storedPreview != null
            ? previewApprovalSets({
                inventory: currentInventory,
                preview: storedPreview,
                excludeIds,
              })
            : null;

        const doneStep = mode === "preview" ? "triage_preview" : "triage_report";
        if (
          await createPublishContext(pool, {
            workItemId: item.id,
            resourceKey: item.resourceKey,
            reviewLens: "triage",
          }).completed(doneStep)
        ) {
          omitTerminal = true;
          return { kind: "completed" };
        }

        await ensureTriageNotCancelled(env);

        const resumeParams = {
          env,
          cfg,
          pool,
          item,
          prSurface,
          headSha,
          headRef: branch.headRef,
          inventory: approval?.approvedInventory ?? currentInventory,
          recoveryInventory: discovered.threads,
          resolutionByRootCommentId: discovered.resolutionByRootCommentId,
          previouslyResolvedCount: discovered.previouslyResolvedCount,
          reportContext: discovered.reportContext,
          leaseEpoch: env.leaseEpoch,
          signal: env.signal,
        };

        if (mode !== "preview") {
          const resumed = await tryResumeStoredPush(resumeParams);
          if (resumed != null) return resumed;
        }

        if (currentInventory.length === 0) {
          return publishEmptyInventoryReport({
            env,
            pool,
            item,
            prSurface,
            headSha,
            scope,
            threads: discovered.threads,
            inventory: discovered.inventory,
            previouslyResolvedCount: discovered.previouslyResolvedCount,
            scopedThreadRootId: discovered.scopedThreadRootId,
            reportContext: discovered.reportContext,
            leaseEpoch: env.leaseEpoch,
          });
        }

        if (mode === "bulk" && approval != null && approval.approvedInventory.length === 0) {
          await publishTriageReportOnly({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            installationId: item.installationId,
            prSurface,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha,
            inventory: currentInventory,
            previouslyResolvedCount: discovered.previouslyResolvedCount,
            leaseEpoch: env.leaseEpoch,
            ...discovered.reportContext,
            body: reportOnlyBody({
              message: `No approved findings to apply. Excluded: ${
                [...approval.excludedIds].join(", ") || "none"
              }. Not in preview: ${[...approval.notInPreviewIds].join(", ") || "none"}.`,
              headSha,
              inventoryCount: currentInventory.length,
              previouslyResolvedCount: discovered.previouslyResolvedCount,
              scope,
            }),
          });
          return { kind: "completed" };
        }

        switch (mode) {
          case "bulk":
            if (storedPreview == null || approval == null) {
              throw new AppError({
                domain: "triage",
                kind: "invalid_preview",
                message: "Bulk apply reached execution without a parsed preview",
              });
            }
            await env.beginAttempt();
            return runBulkFromPreview({
              ...resumeParams,
              cfg,
              botIdentity: discovered.botIdentity,
              scope,
              inventory: currentInventory,
              approvedHunks: approval.approvedHunks,
              preview: storedPreview,
              approvedIds: approval.approvedIds,
              excludedIds: approval.excludedIds,
              notInPreviewIds: approval.notInPreviewIds,
            });
          case "preview":
          case "apply":
            await env.beginAttempt();
            return runFreshTriageAgent({
              ...resumeParams,
              inventory: currentInventory,
              cfg,
              botIdentity: discovered.botIdentity,
              scope,
              mode,
              escalation: env.escalation,
            });
          default: {
            const exhaustive: never = mode;
            return exhaustive;
          }
        }
      })();
      if (!omitTerminal && result.kind === "completed") {
        const durableDegradation = result.degradation?.[0];
        return {
          ...result,
          completion: {
            kind: "triage",
            scope: item.payload.scope ?? "all",
            ...(durableDegradation != null
              ? { outcome: "degraded", durableDegradation }
              : { outcome: "published" }),
          },
        };
      }
      return result;
    },
    onTerminalFailure: async (item, prSurface) => {
      if (!prSurface) return;
      if (
        await createPublishContext(pool, {
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens: "triage",
        }).completed("triage_report")
      ) {
        return;
      }
      await prSurface.replyAt(
        { kind: "prConversation", prNumber: item.prNumber },
        TRIAGE_FAILURE_MESSAGE,
      );
    },
  };
}
