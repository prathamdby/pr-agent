import { join } from "node:path";
import * as v from "valibot";
import type { BotIdentity } from "../github/appAuth.ts";
import {
  type Config,
  DEFERRED_HEAD_SHA,
  isAgentInstructionPath,
  MAX_REPO_POLICY_BYTES,
  MAX_AGENT_INSTRUCTION_BYTES,
  REPO_POLICY_DIRNAME,
} from "../settings/index.ts";
import type { PrSurface } from "../github/prSurface.ts";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.ts";
import { loadRepoPolicy, renderRepoPolicyBlock } from "./repoPolicy.ts";
import {
  loadAgentInstructionFiles,
  renderAgentInstructionFilesBlock,
} from "./agentInstructionFiles.ts";
import { renderProposedPolicyChanges } from "./proposedPolicyChanges.ts";
import { buildTrustedReviewContextForReview } from "../prompts/orchestrator/prompt.ts";
import { fetchPriorInlineFeedbackBlockForReview } from "./run/reviewTrustedContext.ts";
import { buildReviewPathProfile } from "./placement/reviewPathProfile.ts";
import { buildReviewSizeBudget } from "./run/reviewSizeBudget.ts";
import type { ReviewMode } from "./reviewSchema.ts";
import { logWarn } from "../evlog.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import { AppError } from "../errors/appError.ts";
import type { PrRepositoryView } from "../prWorkspace/prRepositoryView.ts";
import { withPrRepositoryView } from "../prWorkspace/prRepositoryView.ts";
import type { ReviewWorkItem, ReviewWorkPayload } from "../agentWork/types.ts";
import type { InstallationSurface } from "../agentWork/installationSurface.ts";
import { createPublishMutationBoundary, type PublishDb } from "../state/publish.ts";
import type { ReviewPublishTarget, ReviewHeadCiPort } from "./publish/reviewPublishSession.ts";
import { sqliteReviewHeadCi } from "./run/reviewHeadCi.ts";
import type { RepoPolicyResult } from "./repoPolicy.ts";

export type ReviewWorkInput = {
  readonly workId: string;
  readonly prKey: string;
  readonly laneEpoch: number;
  readonly payloadJson: string;
};

const reviewPayloadSchema = v.looseObject({
  installationId: v.number(),
  owner: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  headSha: v.string(),
  source: v.picklist(["auto", "slash"]),
  mode: v.optional(v.picklist(["review"])),
  userSupplement: v.optional(v.string()),
  repositorySizeKb: v.optional(v.number()),
  webhookReceivedAt: v.optional(v.number()),
  staleHeadRescheduled: v.optional(v.boolean()),
  commenterId: v.optional(v.number()),
});

export type ReviewAttemptItem = {
  readonly id: string;
  readonly resourceKey: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly source: "auto" | "slash";
  readonly reviewLens: ReviewMode;
  readonly payload: Pick<
    ReviewWorkPayload,
    "source" | "userSupplement" | "repositorySizeKb" | "webhookReceivedAt" | "staleHeadRescheduled"
  >;
};

export function parseReviewWork(input: ReviewWorkInput) {
  const parsed = v.parse(reviewPayloadSchema, JSON.parse(input.payloadJson));
  return ((pinnedReturn: ReviewAttemptItem) => pinnedReturn)({
    id: input.workId,
    resourceKey: input.prKey,
    installationId: parsed.installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    headSha: parsed.headSha,
    source: parsed.source,
    reviewLens: parsed.mode ?? "review",
    payload: {
      source: parsed.source,
      ...(parsed.userSupplement !== undefined ? { userSupplement: parsed.userSupplement } : {}),
      ...(parsed.repositorySizeKb !== undefined
        ? { repositorySizeKb: parsed.repositorySizeKb }
        : {}),
      ...(parsed.webhookReceivedAt !== undefined
        ? { webhookReceivedAt: parsed.webhookReceivedAt }
        : {}),
      ...(parsed.staleHeadRescheduled !== undefined
        ? { staleHeadRescheduled: parsed.staleHeadRescheduled }
        : {}),
    },
  });
}

type SettledPriorInlineFeedback =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: unknown };

export async function buildPriorInlineFeedbackPromise(args: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly cfg: Config;
  readonly item: Pick<ReviewWorkItem, "owner" | "repo" | "prNumber">;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
}) {
  const { cfg, item, reviewLens, prSurface } = args;
  const logPriorFeedbackError = (error: unknown) => {
    logWarn("prior_inline_feedback_fetch_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      reviewLens,
      message: errorMessage(error),
    });
  };
  try {
    const bot = await args.getBotIdentity();
    return ((pinnedReturn: SettledPriorInlineFeedback | Promise<SettledPriorInlineFeedback>) =>
      pinnedReturn)({
      ok: true,
      value: await fetchPriorInlineFeedbackBlockForReview({
        prSurface,
        botUserId: bot.userId,
        reviewLens,
        maintainerDecisionAssociations: cfg.associations.maintainerDecision,
        onPriorFeedbackError: logPriorFeedbackError,
      }),
    });
  } catch (error: unknown) {
    logPriorFeedbackError(error);
    return ((pinnedReturn: SettledPriorInlineFeedback | Promise<SettledPriorInlineFeedback>) =>
      pinnedReturn)({ ok: false, error });
  }
}

export async function assembleTrustedReviewContext(args: {
  readonly repositoryView: PrRepositoryView;
  readonly priorInlineFeedback: string | undefined;
  readonly checkoutCoverage: ReturnType<PrRepositoryView["workspace"]["reader"]["getCoverage"]>;
}) {
  const { repositoryView, priorInlineFeedback, checkoutCoverage } = args;
  const changedFiles = (repositoryView.preflight.files ?? []).map((file) => file.filename);
  const snapshot = repositoryView.workspace.policySnapshot;
  const snapshotFiles = snapshot.kind === "ok" ? snapshot.files : [];
  const [repoPolicy, instructionFiles] = await Promise.all([
    loadRepoPolicy(
      snapshotFiles
        .filter((file) => file.path.endsWith(".mdc"))
        .map((file) => ({ path: file.path, body: file.body })),
      MAX_REPO_POLICY_BYTES,
    ),
    loadAgentInstructionFiles(
      snapshotFiles
        .filter((file) => isAgentInstructionPath(file.path))
        .map((file) => ({ path: file.path, body: file.body })),
      MAX_AGENT_INSTRUCTION_BYTES,
    ),
  ]);
  const agentInstructionFilesBlock =
    instructionFiles.kind === "ok"
      ? renderAgentInstructionFilesBlock({ files: instructionFiles.files }) || undefined
      : undefined;

  if (repoPolicy.kind === "invalid") {
    logWarn("repo_policy_invalid", {
      path: join(repositoryView.agentCwd, REPO_POLICY_DIRNAME),
      reason: repoPolicy.reason,
    });
  }
  const repoPolicyBlock =
    repoPolicy.kind === "ok"
      ? renderRepoPolicyBlock({
          policy: repoPolicy.policy,
          changedFiles,
        }) || undefined
      : undefined;
  const proposedPolicyChangeBlock =
    (await renderProposedPolicyChanges({
      changedFiles: repositoryView.workspace.reader.changedFiles,
      readHead: (path, maxFileBytes) =>
        repositoryView.workspace.reader.readSource(path, maxFileBytes),
    })) || undefined;

  const trustedContext = buildTrustedReviewContextForReview({
    pathProfile: buildReviewPathProfile(
      repositoryView.preflight.files.map((file) => file.filename),
    ),
    sizeBudget: buildReviewSizeBudget(repositoryView.preflight),
    priorInlineFeedback,
    repoPolicyBlock,
    agentInstructionFilesBlock,
    proposedPolicyChangeBlock,
    checkoutCoverage,
    symbolIndexStatus: repositoryView.workspace.reader.getSymbolIndexStatus(),
  });
  return { repoPolicy, trustedContext };
}

export type ReviewAttemptEnv = {
  readonly cfg: Config;
  readonly db: PublishDb;
  readonly item: ReviewAttemptItem;
  readonly target: ReviewPublishTarget;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly pullRequest?: PullRequestForFileList;
  readonly repositoryView: PrRepositoryView;
  readonly trustedContext: string;
  readonly repoPolicy: RepoPolicyResult;
  readonly headCi: ReviewHeadCiPort;
  readonly dispose: () => Promise<void>;
};

export async function openReviewAttemptEnv(params: {
  readonly cfg: Config;
  readonly db: PublishDb;
  readonly installationSurface: InstallationSurface;
  readonly shutdownRequested: () => boolean;
  readonly signal: AbortSignal;
  readonly work: ReviewWorkInput;
  readonly boundHeadSha?: string;
}) {
  const item = parseReviewWork(params.work);
  const target: ReviewPublishTarget = {
    db: params.db,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    laneEpoch: params.work.laneEpoch,
    shutdownRequested: params.shutdownRequested,
    signal: params.signal,
  };
  const prSurface = await params.installationSurface.create({
    cfg: params.cfg,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    mutationBoundary: createPublishMutationBoundary({
      db: params.db,
      workId: item.id,
      prKey: item.resourceKey,
      laneEpoch: params.work.laneEpoch,
      shutdownRequested: params.shutdownRequested,
      signal: params.signal,
    }),
  });
  const resolved =
    params.boundHeadSha !== undefined
      ? { headSha: params.boundHeadSha, pullRequest: undefined }
      : item.headSha === DEFERRED_HEAD_SHA
        ? await prSurface.getHead()
        : { headSha: item.headSha, pullRequest: undefined };
  const headSha = resolved.headSha;
  const pullRequest = "pullRequest" in resolved ? resolved.pullRequest : undefined;
  const priorInlineFeedback = await buildPriorInlineFeedbackPromise({
    getBotIdentity: () => params.installationSurface.botIdentity(params.cfg),
    cfg: params.cfg,
    item,
    reviewLens: item.reviewLens,
    prSurface,
  });
  if (!priorInlineFeedback.ok) throw priorInlineFeedback.error;
  let releaseView: (() => void) | undefined;
  const viewReady = new Promise<PrRepositoryView>((resolveView, rejectView) => {
    const held = withPrRepositoryView(
      {
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        ...(pullRequest !== undefined ? { pullRequest } : {}),
        ...(item.payload.repositorySizeKb !== undefined
          ? { repositorySizeKb: item.payload.repositorySizeKb }
          : {}),
        gitCredentialAuth: () => prSurface.gitCredentialAuth(),
      },
      (view) =>
        new Promise<void>((release) => {
          releaseView = release;
          resolveView(view);
        }),
    );
    held.catch(rejectView);
  });
  const repositoryView = await viewReady;
  const assembled = await assembleTrustedReviewContext({
    repositoryView,
    priorInlineFeedback: priorInlineFeedback.value,
    checkoutCoverage: repositoryView.workspace.reader.getCoverage(),
  });
  return ((pinnedReturn: ReviewAttemptEnv) => pinnedReturn)({
    cfg: params.cfg,
    db: params.db,
    item,
    target,
    prSurface,
    headSha,
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    repositoryView,
    trustedContext: assembled.trustedContext,
    repoPolicy: assembled.repoPolicy,
    headCi: sqliteReviewHeadCi({
      db: params.db,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
    }),
    dispose: async () => {
      releaseView?.();
    },
  });
}

export function reviewAttemptBlocked(message: string, context: Record<string, unknown>) {
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({ domain: "review", kind: "orchestrator_stopped", message, context }),
  );
}

export function logReviewEnvFailure(error: unknown, fields: Record<string, unknown>) {
  logWarn("review_attempt_env_failed", { ...fields, message: errorMessage(error) });
}
