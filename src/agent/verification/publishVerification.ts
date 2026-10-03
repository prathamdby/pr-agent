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
import {
  VERIFICATION_STUB_MARKER,
  VERIFICATION_PUBLISH_LENS,
  type Config,
} from "../../settings/index.js";
import {
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationThreadState,
  matchesVerificationThreadCompletion,
  parseVerificationThreadLedger,
  type VerificationThreadLedger,
  type VerificationThreadState,
  type VerificationThreadCompletion,
} from "../../agentWork/verificationThreadLedger.js";
import {
  operationIntentMarker,
  verificationThreadOperationKey,
  publishOnce,
  type OperationIntentRecovery,
} from "../../agentWork/publishOnce.js";
import {
  getOperationIntent,
  type OperationIntentRow,
} from "../../agentWork/operationIntentRepository.js";
import { AppError, isAppError } from "../../errors/appError.js";
import { isRecord } from "../../util/typeGuards.js";
import {
  safeRecordThreadFindingHistoryOutcome,
  type FindingHistoryOutcome,
} from "../../agentWork/findingHistoryRepository.js";
import type { VerificationDegradationReason } from "../../agentWork/verificationPublishGate.js";

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
  readonly findingHistoryCfg?: Pick<Config, "findingHistory">;
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
  readonly pool: Pool;
  readonly workItemId: string;
  readonly headSha: string;
  readonly verdict: VerificationVerdict["verdict"];
  readonly intent: OperationIntentRow;
  readonly publishRecordId: string | null;
  readonly prSurface: PrSurface;
  readonly marker: string;
  readonly rootCommentId: number;
  readonly requiresResolved: boolean;
  readonly requiresStub: boolean;
  readonly stubCommentId?: number;
  readonly threadNodeId?: string;
  readonly expectedBody: string;
}): Promise<OperationIntentRecovery<number | undefined>> {
  if (params.publishRecordId != null) {
    const { rows } = await params.pool.query<{ detail: unknown }>(
      `SELECT detail FROM publish_records WHERE id = $1 AND work_item_id = $2
        AND review_lens = $3 AND step = 'verification_thread_actions' AND status = 'completed'`,
      [params.publishRecordId, params.workItemId, VERIFICATION_PUBLISH_LENS],
    );
    const receipt = parseVerificationThreadLedger(rows[0]?.detail).threads[
      String(params.rootCommentId)
    ]?.completion;
    if (
      matchesVerificationThreadCompletion(receipt, {
        workItemId: params.workItemId,
        operationKey: params.intent.operationKey,
        headSha: params.headSha,
        verdict: params.verdict,
        requiresStub: params.requiresStub,
      })
    ) {
      return { kind: "reconciled", value: receipt?.stubCommentId };
    }
  }
  const childEvidenceMatches =
    params.intent.detail.headSha === params.headSha &&
    params.intent.detail.verdict === params.verdict &&
    typeof params.intent.detail.requiresStub === "boolean";
  const { rows } = childEvidenceMatches
    ? await params.pool.query<{
        operation_key: string;
        mutation_kind: string;
        detail: Record<string, unknown>;
      }>(
        `SELECT operation_key, mutation_kind, detail FROM operation_intents
      WHERE work_item_id = $1 AND detail->>'parentOperationKey' = $2
        AND detail ? '__result'
      LIMIT 16`,
        [params.workItemId, params.intent.operationKey],
      )
    : { rows: [] };
  let stubCommentId: number | undefined;
  let stubProven = !params.requiresStub;
  let resolved = !params.requiresResolved;
  for (const child of rows) {
    const detail = child.detail;
    if (!isRecord(detail)) continue;
    const method = detail.surfaceMethod;
    if (
      typeof method !== "string" ||
      typeof detail.inputHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(detail.inputHash) ||
      detail.parentOperationKey !== params.intent.operationKey ||
      child.operation_key !==
        `${params.intent.operationKey}:surface:${method}:${detail.inputHash}` ||
      child.mutation_kind !== `github.pr_surface.${method}`
    )
      continue;
    if (
      method === "resolveInlineReviewThread" &&
      detail.threadId === params.threadNodeId &&
      detail.__result === null
    )
      resolved = true;
    if (detail.operationMarker !== params.marker) continue;
    if (method === "editReviewComment" && detail.commentId === params.stubCommentId) {
      if (detail.__result === true) {
        stubProven = true;
        stubCommentId = params.stubCommentId;
      } else if (
        detail.__result === false &&
        (params.verdict === "fixed" || params.verdict === "already-resolved")
      ) {
        // The exact edit receipt proves deletion; a missing listing does not.
        stubProven = true;
      }
    }
    if (
      method === "replyAt" &&
      detail.replyTargetKind === "inlineReviewThread" &&
      detail.inReplyToId === params.rootCommentId &&
      isRecord(detail.__result) &&
      typeof detail.__result.commentId === "number" &&
      Number.isSafeInteger(detail.__result.commentId) &&
      detail.__result.commentId > 0
    ) {
      stubProven = true;
      stubCommentId = detail.__result.commentId;
    }
  }
  if (!stubProven) {
    const botLogin = await params.prSurface.getBotLogin();
    const { comments, truncated } = await params.prSurface.listReviewComments();
    stubCommentId =
      findCommentIdByMarker(
        comments,
        params.marker,
        (comment) =>
          comment.authorLogin === botLogin &&
          comment.inReplyToId === params.rootCommentId &&
          comment.body === params.expectedBody,
      ) ?? undefined;
    stubProven = stubCommentId != null;
    if (!stubProven && truncated)
      throw new Error("Verification stub recovery listing is truncated");
  }
  if (!resolved) {
    const threads = await params.prSurface.listInlineReviewThreads();
    const thread = threads.byRootCommentId.get(params.rootCommentId);
    resolved = thread?.isResolved === true && thread.threadNodeId === params.threadNodeId;
    if (!resolved && (threads.status !== "ok" || threads.truncated)) {
      throw new Error("Verification resolution recovery is unavailable or incomplete");
    }
  }
  if ((!stubProven || !resolved) && rows.length >= 16) {
    throw new Error("Verification child receipt recovery is capped");
  }
  return stubProven && resolved ? { kind: "reconciled", value: stubCommentId } : { kind: "absent" };
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
    headSha: params.headSha,
  };
}

async function withVerificationThreadOperation(
  params: PublishVerificationParams,
  verdict: VerificationVerdict,
  requiresResolved: boolean,
  requirements: {
    readonly requiresStub: boolean;
    readonly stubCommentId?: number;
    readonly threadNodeId?: string;
    readonly body: (marker: string) => string;
  },
  mutate: (operationMarker: string, accepted: () => void) => Promise<number | undefined>,
): Promise<{ readonly stubCommentId?: number; readonly completion: VerificationThreadCompletion }> {
  const operationKey = verificationThreadOperationKey(verdict.threadRootCommentId);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const retained = await getOperationIntent(params.pool, params.workItemId, operationKey);
  if (
    retained != null &&
    ((typeof retained.detail.headSha === "string" && retained.detail.headSha !== params.headSha) ||
      (typeof retained.detail.verdict === "string" && retained.detail.verdict !== verdict.verdict))
  ) {
    throw new AppError({
      domain: "operation_intent",
      kind: "mutation_outcome_unknown",
      message: "Verification operation identity no longer matches its retained head and verdict",
      context: { workItemId: params.workItemId, operationKey, unknownResolution: "terminal" },
    });
  }
  const requiresStub =
    typeof retained?.detail.requiresStub === "boolean"
      ? retained.detail.requiresStub
      : retained != null &&
          (retained.status === "outcome_unknown" ||
            retained.status === "reconciled" ||
            retained.detail.__mutating === true)
        ? true
        : requirements.requiresStub;
  const expectedStubId =
    typeof retained?.detail.stubCommentId === "number"
      ? retained.detail.stubCommentId
      : requirements.stubCommentId;
  let childAccepted = false;
  let resolutionDenied = false;
  const stubCommentId = await publishOnce<number | undefined>({
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.verification_thread",
    allowsUndefinedResult: false,
    detail: {
      ...verificationIntentDetail(
        params,
        verdict.threadRootCommentId,
        verdict.verdict,
        operationMarker,
      ),
      requiresStub,
      ...(expectedStubId != null ? { stubCommentId: expectedStubId } : {}),
      ...(requirements.threadNodeId != null ? { threadNodeId: requirements.threadNodeId } : {}),
    },
    recover: async (intent, publishRecordId) => {
      // A proven denial is already the terminal decision for this dispatch.
      // Do not mask it with a failing observational read after partial acceptance.
      if (resolutionDenied) return { kind: "absent" };
      return recoverVerificationMutation({
        pool: params.pool,
        workItemId: params.workItemId,
        headSha: params.headSha,
        verdict: verdict.verdict,
        intent,
        publishRecordId: publishRecordId ?? intent.publishRecordId,
        prSurface: params.prSurface,
        marker: operationMarker,
        rootCommentId: verdict.threadRootCommentId,
        requiresResolved,
        requiresStub,
        stubCommentId: expectedStubId,
        threadNodeId: requirements.threadNodeId,
        expectedBody: requirements.body(operationMarker),
      });
    },
    // A later child denial cannot undo a stub that was already accepted.
    isKnownNoAcceptanceError: (error) => {
      resolutionDenied =
        isAppError(error) && error.code === "github.review_thread_resolution_denied";
      return !childAccepted && isKnownNoAcceptanceMutationError(error);
    },
    mutate: () =>
      mutate(operationMarker, () => {
        childAccepted = true;
      }),
  });
  return {
    ...(stubCommentId != null ? { stubCommentId } : {}),
    completion: {
      workItemId: params.workItemId,
      operationKey,
      headSha: params.headSha,
      verdict: verdict.verdict,
      stubOutcome: !requiresStub ? "not_required" : stubCommentId != null ? "written" : "missing",
      ...(stubCommentId != null ? { stubCommentId } : {}),
      resolutionOutcome: requiresResolved ? "resolved" : "not_required",
    },
  };
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
): Promise<{ degradation: readonly VerificationDegradationReason[] }> {
  const degradation = new Set<VerificationDegradationReason>();
  if (params.changedFilePathsTruncated === true) degradation.add("compare_files_truncated");
  let ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  const changedFiles = new Set(params.changedFilePaths);
  const changedMembershipComplete = params.changedFilePathsTruncated !== true;

  for (const verdict of params.payload.verdicts) {
    const thread = threadById.get(verdict.threadRootCommentId);
    if (!thread) {
      degradation.add("verdict_mapping_incomplete");
      continue;
    }

    const prior = ledger.threads[String(verdict.threadRootCommentId)];

    switch (verdict.verdict) {
      case "fixed":
      case "already-resolved": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        if (!resolution) {
          degradation.add("verdict_mapping_incomplete");
          break;
        }
        const priorStubId = resolveStubCommentId(thread, prior);
        const { stubCommentId, completion } = await withVerificationThreadOperation(
          params,
          verdict,
          true,
          {
            requiresStub: priorStubId != null,
            stubCommentId: priorStubId,
            threadNodeId: resolution.threadNodeId,
            body: (marker) => terminalSuccessStubBody(verdict, marker),
          },
          async (operationMarker, accepted) => {
            let nextStubCommentId: number | undefined = priorStubId;
            if (priorStubId != null) {
              const updated = await updateStubReply({
                prSurface: params.prSurface,
                stubCommentId: priorStubId,
                body: terminalSuccessStubBody(verdict, operationMarker),
              });
              if (!updated) nextStubCommentId = undefined;
              else accepted();
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
          state: {
            ...terminalThreadState(prior, verdict.verdict, params.headSha, stubCommentId),
            completion,
          },
        });
        recordVerificationHistoryOutcome(params, thread, verdict.verdict);
        break;
      }
      case "skipped": {
        // When compare is truncated, omitted paths must not suppress still-open stubs.
        if (changedMembershipComplete && !changedFiles.has(thread.path)) break;
        const { stubCommentId, completion } = await withVerificationThreadOperation(
          params,
          verdict,
          false,
          {
            requiresStub: true,
            stubCommentId: resolveStubCommentId(thread, prior),
            body: (marker) =>
              withStubMarker(
                redactReviewText(`**Verification**: Still open - ${verdict.reason}`),
                marker,
              ),
          },
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
            completion,
          },
        });
        recordVerificationHistoryOutcome(params, thread, "skipped");
        break;
      }
      case "dismissed": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        if (!resolution) {
          degradation.add("verdict_mapping_incomplete");
          break;
        }
        const { stubCommentId, completion } = await withVerificationThreadOperation(
          params,
          verdict,
          true,
          {
            requiresStub: true,
            stubCommentId: resolveStubCommentId(thread, prior),
            threadNodeId: resolution.threadNodeId,
            body: (marker) => dismissedReplyBody(verdict, thread, params.policyResult, marker),
          },
          async (operationMarker, accepted) => {
            const createdStubCommentId = await upsertStubComment({
              prSurface: params.prSurface,
              prNumber: params.prNumber,
              thread,
              stubCommentId: resolveStubCommentId(thread, prior),
              body: dismissedReplyBody(verdict, thread, params.policyResult, operationMarker),
            });
            accepted();
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
          state: {
            ...terminalThreadState(prior, "dismissed", params.headSha, stubCommentId),
            completion,
          },
        });
        recordVerificationHistoryOutcome(params, thread, "dismissed");
        break;
      }
      default: {
        const _exhaustive: never = verdict;
        void _exhaustive;
        degradation.add("verdict_mapping_incomplete");
        break;
      }
    }
  }

  return { degradation: [...degradation] };
}
