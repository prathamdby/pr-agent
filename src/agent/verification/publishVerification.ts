import type { Pool } from "pg";
import type { PrSurface } from "../../github/prSurface.js";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import type { ReviewThreadResolution } from "../../github/reviewThreadResolution.js";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.js";
import {
  renderPolicySuggestionForDismissed,
  type RepoPolicyResult,
} from "../../review/repoPolicy.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { VerificationPayload, VerificationVerdict } from "../../review/triageSchema.js";
import { VERIFICATION_STUB_MARKER, VERIFICATION_PUBLISH_LENS } from "../../settings/index.js";
import {
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationThreadState,
  type VerificationThreadLedger,
  type VerificationThreadState,
} from "../../agentWork/verificationThreadLedger.js";
import {
  operationIntentMarker,
  verificationThreadOperationKey,
  withOperationIntent,
} from "../../agentWork/withOperationIntent.js";
import {
  safeRecordThreadFindingHistoryOutcome,
  type FindingHistoryOutcome,
} from "../../agentWork/findingHistoryRepository.js";
import type { Config } from "../../config.js";

type PublishVerificationParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly installationId: number;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly payload: VerificationPayload;
  readonly changedFilePaths: readonly string[];
  /** When true, changedFilePaths is incomplete (GitHub compare 300-file cap). */
  readonly changedFilePathsTruncated?: boolean;
  readonly policyResult: RepoPolicyResult;
  readonly findingHistoryCfg?: Pick<Config, "findingHistoryEnabled">;
  readonly leaseEpoch: number | null;
};

function withStubMarker(body: string, operationMarker?: string): string {
  const marked = body.includes(VERIFICATION_STUB_MARKER)
    ? body
    : `${VERIFICATION_STUB_MARKER}\n${body}`;
  return operationMarker == null || marked.includes(operationMarker)
    ? marked
    : `${marked}\n${operationMarker}`;
}

function terminalSuccessStubBody(
  verdict: Extract<VerificationVerdict, { verdict: "fixed" | "already-resolved" }>,
  operationMarker?: string,
): string {
  const label = verdict.verdict === "fixed" ? "Fixed" : "Already resolved";
  return withStubMarker(redactReviewText(`**Verification**: ${label}`), operationMarker);
}

function dismissedReplyBody(
  verdict: Extract<VerificationVerdict, { verdict: "dismissed" }>,
  thread: BotFindingThread,
  policyResult: RepoPolicyResult,
  operationMarker?: string,
): string {
  const evidence = redactReviewText(`**Verification**: Dismissed - ${verdict.evidence}`);
  const suggestion = renderPolicySuggestionForDismissed({
    filePath: thread.path,
    dismissalEvidence: verdict.evidence,
    policyResult,
  });
  return withStubMarker(`${evidence}\n\nSuggested policy entry:\n\n${suggestion}`, operationMarker);
}

async function recoverVerificationMutation(params: {
  readonly prSurface: PrSurface;
  readonly marker: string;
  readonly rootCommentId: number;
  readonly requiresResolved: boolean;
}): Promise<number | undefined | null> {
  const botLogin = await params.prSurface.getBotLogin?.();
  if (botLogin == null) return null;
  const comments = await params.prSurface.listInlineReviewComments();
  const markedCommentId = findCommentIdByMarker(
    comments,
    params.marker,
    (comment) => comment.authorLogin === botLogin && comment.inReplyToId === params.rootCommentId,
  );
  if (params.requiresResolved) {
    const threads = await params.prSurface.listInlineReviewThreads();
    if (threads.byRootCommentId.get(params.rootCommentId)?.isResolved !== true) return null;
    return markedCommentId ?? undefined;
  }
  return markedCommentId;
}

function resolveStubCommentId(
  thread: BotFindingThread,
  state: VerificationThreadState | undefined,
): number | undefined {
  return state?.stubCommentId ?? thread.verificationStubCommentId;
}

async function createStubReply(params: {
  readonly prSurface: PrSurface;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly body: string;
}): Promise<number> {
  const posted = await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    params.body,
  );
  return posted.commentId;
}

async function updateStubReply(params: {
  readonly prSurface: PrSurface;
  readonly stubCommentId: number;
  readonly body: string;
}): Promise<boolean> {
  return params.prSurface.editReviewComment(params.stubCommentId, params.body);
}

async function upsertStubComment(params: {
  readonly prSurface: PrSurface;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly stubCommentId: number | undefined;
  readonly body: string;
}): Promise<number> {
  if (params.stubCommentId != null) {
    const updated = await updateStubReply({
      prSurface: params.prSurface,
      stubCommentId: params.stubCommentId,
      body: params.body,
    });
    if (updated) return params.stubCommentId;
  }
  return createStubReply(params);
}

async function persistThreadState(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly ledger: VerificationThreadLedger;
  readonly rootCommentId: number;
  readonly state: VerificationThreadState;
  readonly leaseEpoch: number | null;
}): Promise<VerificationThreadLedger> {
  const next = upsertVerificationThreadState(params.ledger, params.rootCommentId, params.state);
  await saveVerificationThreadLedger(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    ledger: next,
    leaseEpoch: params.leaseEpoch,
  });
  return next;
}

function terminalThreadState(
  prior: VerificationThreadState | undefined,
  lastVerdict: VerificationThreadState["lastVerdict"],
  lastHeadSha: string,
  stubCommentId?: number,
): VerificationThreadState {
  const resolvedStubId = stubCommentId ?? prior?.stubCommentId;
  return {
    ...(resolvedStubId != null ? { stubCommentId: resolvedStubId } : {}),
    lastVerdict,
    lastHeadSha,
    terminal: true,
  };
}

function verificationIntentDetail(
  params: PublishVerificationParams,
  threadRootCommentId: number,
  verdict: string,
  operationMarker: string,
): Record<string, unknown> {
  return {
    step: "verification_thread_actions",
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    threadRootCommentId,
    verdict,
    operationMarker,
  };
}

async function withVerificationThreadOperation(
  params: PublishVerificationParams,
  verdict: VerificationVerdict,
  requiresResolved: boolean,
  mutate: (operationMarker: string) => Promise<number | undefined>,
): Promise<number | undefined> {
  const operationKey = verificationThreadOperationKey(verdict.threadRootCommentId);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  return withOperationIntent<number | undefined>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.verification_thread",
    allowsUndefinedResult: true,
    detail: verificationIntentDetail(
      params,
      verdict.threadRootCommentId,
      verdict.verdict,
      operationMarker,
    ),
    recover: async () => {
      const recovered = await recoverVerificationMutation({
        prSurface: params.prSurface,
        marker: operationMarker,
        rootCommentId: verdict.threadRootCommentId,
        requiresResolved,
      });
      return recovered == null
        ? { kind: "absent" as const }
        : { kind: "reconciled" as const, value: recovered };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: () => mutate(operationMarker),
  });
}

function recordVerificationHistoryOutcome(
  params: PublishVerificationParams,
  thread: BotFindingThread,
  outcome: Exclude<FindingHistoryOutcome, "open">,
): void {
  if (!params.findingHistoryCfg) return;
  safeRecordThreadFindingHistoryOutcome(params.pool, params.findingHistoryCfg, {
    scope: {
      installationId: params.installationId,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      workItemId: params.workItemId,
      headSha: params.headSha,
    },
    resourceKey: params.resourceKey,
    thread,
    outcome,
  });
}

export async function publishVerification(
  params: PublishVerificationParams,
): Promise<{ degraded: boolean }> {
  let degraded = params.changedFilePathsTruncated === true;
  let ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  const changedFiles = new Set(params.changedFilePaths);
  const changedMembershipComplete = params.changedFilePathsTruncated !== true;

  for (const verdict of params.payload.verdicts) {
    const thread = threadById.get(verdict.threadRootCommentId);
    if (!thread) {
      degraded = true;
      continue;
    }

    const prior = ledger.threads[String(verdict.threadRootCommentId)];

    switch (verdict.verdict) {
      case "fixed":
      case "already-resolved": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        if (!resolution) {
          degraded = true;
          break;
        }
        const stubCommentId = await withVerificationThreadOperation(
          params,
          verdict,
          true,
          async (operationMarker) => {
            const priorStubId = resolveStubCommentId(thread, prior);
            let nextStubCommentId: number | undefined = priorStubId;
            if (priorStubId != null) {
              const updated = await updateStubReply({
                prSurface: params.prSurface,
                stubCommentId: priorStubId,
                body: terminalSuccessStubBody(verdict, operationMarker),
              });
              if (!updated) nextStubCommentId = undefined;
            }
            if (!resolution.isResolved) {
              await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
            }
            return nextStubCommentId;
          },
        );
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          leaseEpoch: params.leaseEpoch,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: terminalThreadState(prior, verdict.verdict, params.headSha, stubCommentId),
        });
        recordVerificationHistoryOutcome(params, thread, verdict.verdict);
        break;
      }
      case "skipped": {
        // When compare is truncated, omitted paths must not suppress still-open stubs.
        if (changedMembershipComplete && !changedFiles.has(thread.path)) break;
        const stubCommentId = await withVerificationThreadOperation(
          params,
          verdict,
          false,
          async (operationMarker) =>
            upsertStubComment({
              prSurface: params.prSurface,
              prNumber: params.prNumber,
              thread,
              stubCommentId: resolveStubCommentId(thread, prior),
              body: withStubMarker(
                redactReviewText(`**Verification**: Still open - ${verdict.reason}`),
                operationMarker,
              ),
            }),
        );
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          leaseEpoch: params.leaseEpoch,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: {
            stubCommentId,
            lastVerdict: "skipped",
            lastHeadSha: params.headSha,
          },
        });
        recordVerificationHistoryOutcome(params, thread, "skipped");
        break;
      }
      case "dismissed": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        if (!resolution) {
          degraded = true;
          break;
        }
        const stubCommentId = await withVerificationThreadOperation(
          params,
          verdict,
          true,
          async (operationMarker) => {
            const createdStubCommentId = await upsertStubComment({
              prSurface: params.prSurface,
              prNumber: params.prNumber,
              thread,
              stubCommentId: resolveStubCommentId(thread, prior),
              body: dismissedReplyBody(verdict, thread, params.policyResult, operationMarker),
            });
            if (!resolution.isResolved) {
              await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
            }
            return createdStubCommentId;
          },
        );
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          leaseEpoch: params.leaseEpoch,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: terminalThreadState(prior, "dismissed", params.headSha, stubCommentId),
        });
        recordVerificationHistoryOutcome(params, thread, "dismissed");
        break;
      }
      default: {
        const _exhaustive: never = verdict;
        void _exhaustive;
        degraded = true;
        break;
      }
    }
  }

  return { degraded };
}
