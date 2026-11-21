import * as v from "valibot";
import type { PrSurface } from "../../github/prSurface.ts";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import type {
  ReviewThreadResolution,
  ReviewThreadSnapshot,
} from "../../github/reviewThreadResolution.ts";
import { logInfo } from "../../evlog.ts";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.ts";
import {
  renderPolicySuggestionForDismissed,
  type RepoPolicyResult,
} from "../../review/repoPolicy.ts";
import {
  appendRootResolutionReceipt,
  unpostedResolutionReceipt,
} from "../../review/findingIdentity/resolutionReceipt.ts";
import type { BotFindingThread, FindingObjection } from "../../review/run/reviewPriorFeedback.ts";
import {
  commentCarriesObjectionAnswer,
  isBotAuthor,
  renderObjectionAnswerMarker,
  withoutObjectionAnswerMarkers,
} from "../../review/findingIdentity/findingMarker.ts";
import type {
  VerificationObjectionDecision,
  VerificationPayload,
  VerificationVerdict,
} from "../../review/triageSchema.ts";
import { VERIFICATION_STUB_MARKER, VERIFICATION_PUBLISH_LENS } from "../../settings/index.ts";
import {
  loadVerificationThreadLedger,
  upsertVerificationThreadState,
  matchesVerificationThreadCompletion,
  type VerificationObjectionJournalEntry,
  type VerificationThreadLedger,
  type VerificationThreadState,
  type VerificationThreadCompletion,
} from "../../state/verificationThreadLedger.ts";
import {
  intentIdentity,
  operationIntentMarker,
  verificationObjectionAnswerOperationKey,
  verificationThreadOperationKey,
  type FeaturePublication,
} from "../../state/featurePublication.ts";
import type { PublishIntentRow, PublishRecovery } from "../../state/publish.ts";
import { AppError, isAppError } from "../../errors/appError.ts";
import type { VerificationDegradationReason } from "../../agentWork/verificationPublishGate.ts";

type PublishVerificationParams = {
  readonly publication: FeaturePublication;
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
  readonly changedFilePathsTruncated?: boolean;
  readonly changedMembershipComplete?: boolean;
  readonly policyResult: RepoPolicyResult;
};

function withStubMarker(body: string, operationMarker?: string) {
  const marked = body.includes(VERIFICATION_STUB_MARKER)
    ? body
    : `${VERIFICATION_STUB_MARKER}\n${body}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    operationMarker == null || marked.includes(operationMarker)
      ? marked
      : `${marked}\n${operationMarker}`,
  );
}

function terminalSuccessStubBody(
  verdict: Extract<VerificationVerdict, { verdict: "fixed" | "already-resolved" }>,
  operationMarker?: string,
) {
  const label = verdict.verdict === "fixed" ? "Fixed" : "Already resolved";
  return ((pinnedReturn: string) => pinnedReturn)(
    withStubMarker(redactReviewText(`**Verification**: ${label}`), operationMarker),
  );
}

function dismissedReplyBody(
  verdict: Extract<VerificationVerdict, { verdict: "dismissed" }>,
  thread: BotFindingThread,
  policyResult: RepoPolicyResult,
  operationMarker?: string,
) {
  const evidence = redactReviewText(`**Verification**: Dismissed - ${verdict.evidence}`);
  const suggestion = renderPolicySuggestionForDismissed({
    filePath: thread.path,
    dismissalEvidence: verdict.evidence,
    policyResult,
  });
  return ((pinnedReturn: string) => pinnedReturn)(
    withStubMarker(`${evidence}\n\nSuggested policy entry:\n\n${suggestion}`, operationMarker),
  );
}

async function recoverVerificationMutation(params: {
  readonly publication: FeaturePublication;
  readonly resourceKey: string;
  readonly workItemId: string;
  readonly headSha: string;
  readonly verdict: VerificationVerdict["verdict"];
  readonly intent: PublishIntentRow;
  readonly prSurface: PrSurface;
  readonly marker: string;
  readonly rootCommentId: number;
  readonly requiresResolved: boolean;
  readonly requiresStub: boolean;
  readonly threadNodeId?: string;
  readonly expectedBody: string;
}) {
  const receipt = loadVerificationThreadLedger(params.publication.db, {
    resourceKey: params.resourceKey,
  }).threads[String(params.rootCommentId)]?.completion;
  if (
    matchesVerificationThreadCompletion(receipt, {
      workItemId: params.workItemId,
      operationKey: params.intent.operation_key,
      headSha: params.headSha,
      verdict: params.verdict,
      requiresStub: params.requiresStub,
    })
  ) {
    return ((pinnedReturn: PublishRecovery | Promise<PublishRecovery>) => pinnedReturn)({
      found: true,
      value: receipt?.stubCommentId ?? null,
    });
  }
  let stubCommentId: number | undefined;
  let stubProven = !params.requiresStub;
  let resolved = !params.requiresResolved;
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
  return ((pinnedReturn: PublishRecovery | Promise<PublishRecovery>) => pinnedReturn)(
    stubProven && resolved ? { found: true, value: stubCommentId ?? null } : { found: false },
  );
}

function resolveStubCommentId(
  thread: BotFindingThread,
  state: VerificationThreadState | undefined,
) {
  return ((pinnedReturn: number | undefined) => pinnedReturn)(
    state?.stubCommentId ?? thread.verificationStubCommentId,
  );
}

async function createStubReply(params: {
  readonly prSurface: PrSurface;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly body: string;
}) {
  const posted = await params.prSurface.replyAt(
    {
      kind: "inlineReviewThread",
      prNumber: params.prNumber,
      inReplyToCommentId: params.thread.rootCommentId,
    },
    params.body,
  );
  return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(posted.commentId);
}

async function updateStubReply(params: {
  readonly prSurface: PrSurface;
  readonly stubCommentId: number;
  readonly body: string;
}) {
  return ((pinnedReturn: boolean | Promise<boolean>) => pinnedReturn)(
    params.prSurface.editReviewComment(params.stubCommentId, params.body),
  );
}

async function upsertStubComment(params: {
  readonly prSurface: PrSurface;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly stubCommentId: number | undefined;
  readonly body: string;
}) {
  if (params.stubCommentId != null) {
    const updated = await updateStubReply({
      prSurface: params.prSurface,
      stubCommentId: params.stubCommentId,
      body: params.body,
    });
    if (updated)
      return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(params.stubCommentId);
  }
  return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(createStubReply(params));
}

async function persistThreadState(params: {
  readonly publication: FeaturePublication;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly ledger: VerificationThreadLedger;
  readonly rootCommentId: number;
  readonly state: VerificationThreadState;
}) {
  const next = upsertVerificationThreadState(params.ledger, params.rootCommentId, params.state);
  params.publication.record({
    lens: VERIFICATION_PUBLISH_LENS,
    step: "verification_thread_actions",
    detail: {
      threads: next.threads,
      ...(next.failureSignal != null ? { failureSignal: next.failureSignal } : {}),
    },
  });
  return ((pinnedReturn: VerificationThreadLedger | Promise<VerificationThreadLedger>) =>
    pinnedReturn)(next);
}

function terminalThreadState(
  prior: VerificationThreadState | undefined,
  lastVerdict: VerificationThreadState["lastVerdict"],
  lastHeadSha: string,
  stubCommentId?: number,
) {
  const resolvedStubId = stubCommentId ?? prior?.stubCommentId;
  return ((pinnedReturn: VerificationThreadState) => pinnedReturn)({
    ...(resolvedStubId != null ? { stubCommentId: resolvedStubId } : {}),
    lastVerdict,
    lastHeadSha,
    terminal: true,
  });
}

function verificationIntentDetail(
  params: PublishVerificationParams,
  threadRootCommentId: number,
  verdict: string,
  operationMarker: string,
) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({
    step: "verification_thread_actions",
    resourceKey: params.resourceKey,
    reviewLens: VERIFICATION_PUBLISH_LENS,
    threadRootCommentId,
    verdict,
    operationMarker,
    headSha: params.headSha,
  });
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
) {
  const operationKey = verificationThreadOperationKey(verdict.threadRootCommentId);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const retained = params.publication.intent(operationKey);
  const retainedIdentity = intentIdentity(retained);
  if (
    retained != null &&
    ((typeof retainedIdentity.headSha === "string" &&
      retainedIdentity.headSha !== params.headSha) ||
      (typeof retainedIdentity.verdict === "string" &&
        retainedIdentity.verdict !== verdict.verdict))
  ) {
    throw new AppError({
      domain: "operation_intent",
      kind: "mutation_outcome_unknown",
      message: "Verification operation identity no longer matches its retained head and verdict",
      context: { workItemId: params.workItemId, operationKey, unknownResolution: "terminal" },
    });
  }
  const requiresStub =
    typeof retainedIdentity.requiresStub === "boolean"
      ? retainedIdentity.requiresStub
      : retained != null && retained.state !== "reserved" && retained.state !== "mutation_failed"
        ? true
        : requirements.requiresStub;
  const expectedStubId =
    typeof retainedIdentity.stubCommentId === "number"
      ? retainedIdentity.stubCommentId
      : requirements.stubCommentId;
  let childAccepted = false;
  let resolutionDenied = false;
  const stubCommentId = await params.publication
    .once<number | undefined>({
      decodeResult: (value) => {
        v.assert(v.nullish(v.number()), value);
        return value ?? undefined;
      },
      allowsUndefinedResult: true,
      resourceTarget: `thread:${verdict.threadRootCommentId}`,
      blocksOverwrite: true,
      operationKey,
      mutationKind: "github.verification_thread",
      identity: {
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
      recover: async (intent) => {
        if (resolutionDenied) return { found: false };
        return recoverVerificationMutation({
          publication: params.publication,
          resourceKey: params.resourceKey,
          workItemId: params.workItemId,
          headSha: params.headSha,
          verdict: verdict.verdict,
          intent,
          prSurface: params.prSurface,
          marker: operationMarker,
          rootCommentId: verdict.threadRootCommentId,
          requiresResolved,
          requiresStub,
          threadNodeId: requirements.threadNodeId,
          expectedBody: requirements.body(operationMarker),
        });
      },
      isKnownNoAcceptanceError: (error) => {
        resolutionDenied =
          isAppError(error) && error.code === "github.review_thread_resolution_denied";
        return !childAccepted && isKnownNoAcceptanceMutationError(error);
      },
      mutate: () =>
        mutate(operationMarker, () => {
          childAccepted = true;
        }),
    })
    .catch((error: unknown) => {
      if (resolutionDenied && error instanceof Error && error.cause instanceof Error)
        throw error.cause;
      throw error;
    });
  return ((
    pinnedReturn:
      | { readonly stubCommentId?: number; readonly completion: VerificationThreadCompletion }
      | Promise<{
          readonly stubCommentId?: number;
          readonly completion: VerificationThreadCompletion;
        }>,
  ) => pinnedReturn)({
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
  });
}

const VERIFICATION_REPLY_PREFIX = "**Verification reply**:";
const UNAUTHORIZED_CONCEDE_SENTENCE = "A maintainer can dismiss this finding.";

export type VerificationPublishResult = {
  readonly degradation: readonly VerificationDegradationReason[];
  readonly objectionsAnswered?: number;
  readonly objectionsNotObjection?: number;
  readonly objectionsSkippedIncomplete?: number;
};

type ObjectionPublishCounts = {
  answered: number;
  notObjection: number;
  skippedIncomplete: number;
};

type ObjectionPostResult = {
  readonly journal: readonly VerificationObjectionJournalEntry[];
  readonly revisionMoved: boolean;
  readonly pageIncomplete: boolean;
  readonly answered: number;
  readonly notObjection: number;
  readonly skippedIncomplete: number;
};

function objectionDecisionsFor(thread: BotFindingThread, payload: VerificationPayload) {
  const ids = new Set((thread.objections ?? []).map((objection) => objection.commentId));
  return ((pinnedReturn: readonly VerificationObjectionDecision[]) => pinnedReturn)(
    (payload.objectionDecisions ?? []).filter((decision) => ids.has(decision.commentId)),
  );
}

function notObjectionEntries(decisions: readonly VerificationObjectionDecision[]) {
  return ((pinnedReturn: readonly VerificationObjectionJournalEntry[]) => pinnedReturn)(
    decisions.flatMap((decision) =>
      decision.decision === "not_objection"
        ? [
            {
              commentId: decision.commentId,
              updatedAt: decision.updatedAt,
              decision: decision.decision,
            },
          ]
        : [],
    ),
  );
}

function mergeObjectionJournal(
  prior: readonly VerificationObjectionJournalEntry[] | undefined,
  journal: readonly VerificationObjectionJournalEntry[],
) {
  const byKey = new Map<string, VerificationObjectionJournalEntry>();
  for (const entry of prior ?? []) byKey.set(`${entry.commentId}:${entry.updatedAt}`, entry);
  for (const entry of journal) byKey.set(`${entry.commentId}:${entry.updatedAt}`, entry);
  return ((pinnedReturn: readonly VerificationObjectionJournalEntry[]) => pinnedReturn)([
    ...byKey.values(),
  ]);
}

function withObjectionJournal(
  state: VerificationThreadState,
  prior: VerificationThreadState | undefined,
  journal: readonly VerificationObjectionJournalEntry[],
) {
  const objections = mergeObjectionJournal(prior?.objections, journal);
  return ((pinnedReturn: VerificationThreadState) => pinnedReturn)(
    objections.length > 0 ? { ...state, objections } : state,
  );
}

function journalOnlyState(
  prior: VerificationThreadState | undefined,
  verdict: VerificationThreadState["lastVerdict"],
  journal: readonly VerificationObjectionJournalEntry[],
) {
  const objections = mergeObjectionJournal(prior?.objections, journal);
  const base = prior ?? { lastVerdict: verdict };
  return ((pinnedReturn: VerificationThreadState) => pinnedReturn)(
    objections.length > 0 ? { ...base, objections } : base,
  );
}

function objectionAnswerProse(
  decision: Extract<VerificationObjectionDecision, { decision: "concede" | "hold" }>,
  verdict: VerificationVerdict,
  objection: FindingObjection,
) {
  const prose = decision.body.startsWith(VERIFICATION_REPLY_PREFIX)
    ? decision.body
    : `${VERIFICATION_REPLY_PREFIX}\n${decision.body}`;
  const withFix =
    verdict.verdict === "fixed" && !prose.includes(verdict.commitSha)
      ? `${prose}\n\nFixed in ${verdict.commitSha}.`
      : prose;
  if (
    decision.decision === "concede" &&
    !objection.authorized &&
    !withFix.includes(UNAUTHORIZED_CONCEDE_SENTENCE)
  ) {
    return ((pinnedReturn: string) => pinnedReturn)(
      `${withFix}\n\n${UNAUTHORIZED_CONCEDE_SENTENCE}`,
    );
  }
  return ((pinnedReturn: string) => pinnedReturn)(withFix);
}

function objectionAnswerBody(
  decision: Extract<VerificationObjectionDecision, { decision: "concede" | "hold" }>,
  verdict: VerificationVerdict,
  objection: FindingObjection,
  operationMarker: string,
) {
  const redacted = withoutObjectionAnswerMarkers(
    redactReviewText(objectionAnswerProse(decision, verdict, objection)),
  ).trimEnd();
  const answerMarker = renderObjectionAnswerMarker(decision.commentId, decision.updatedAt);
  const withAnswer = `${redacted}\n${answerMarker}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    withAnswer.includes(operationMarker) ? withAnswer : `${withAnswer}\n${operationMarker}`,
  );
}

function existingAnswerCommentId(
  snapshot: ReviewThreadSnapshot,
  botLogin: string,
  commentId: number,
  updatedAt: string,
) {
  const match = snapshot.comments.find(
    (comment) =>
      isBotAuthor(comment.authorLogin, botLogin) &&
      commentCarriesObjectionAnswer(comment.body, commentId, updatedAt),
  );
  return ((pinnedReturn: number | undefined) => pinnedReturn)(match?.databaseId);
}

function noteObjectionCounts(counts: ObjectionPublishCounts, posted: ObjectionPostResult) {
  counts.answered += posted.answered;
  counts.notObjection += posted.notObjection;
  counts.skippedIncomplete += posted.skippedIncomplete;
}

async function recoverObjectionAnswer(params: {
  readonly publication: FeaturePublication;
  readonly resourceKey: string;
  readonly prSurface: PrSurface;
  readonly rootCommentId: number;
  readonly objectionCommentId: number;
  readonly updatedAt: string;
}) {
  const entry = loadVerificationThreadLedger(params.publication.db, {
    resourceKey: params.resourceKey,
  }).threads[String(params.rootCommentId)]?.objections?.find(
    (objection) =>
      objection.commentId === params.objectionCommentId &&
      objection.updatedAt === params.updatedAt &&
      objection.answerCommentId != null,
  );
  if (entry?.answerCommentId != null)
    return ((pinnedReturn: PublishRecovery | Promise<PublishRecovery>) => pinnedReturn)({
      found: true,
      value: entry.answerCommentId,
    });
  const botLogin = await params.prSurface.getBotLogin();
  const listed = await params.prSurface.listReviewComments();
  if (listed.truncated) {
    throw new Error("Verification objection answer recovery listing is truncated");
  }
  const commentId = findCommentIdByMarker(
    listed.comments,
    renderObjectionAnswerMarker(params.objectionCommentId, params.updatedAt),
    (comment) => isBotAuthor(comment.authorLogin, botLogin),
  );
  return ((pinnedReturn: PublishRecovery | Promise<PublishRecovery>) => pinnedReturn)(
    commentId != null ? { found: true, value: commentId } : { found: false },
  );
}

async function publishObjectionAnswer(params: {
  readonly publish: PublishVerificationParams;
  readonly thread: BotFindingThread;
  readonly verdict: VerificationVerdict;
  readonly decision: Extract<VerificationObjectionDecision, { decision: "concede" | "hold" }>;
  readonly objection: FindingObjection;
}) {
  const operationKey = verificationObjectionAnswerOperationKey(
    params.thread.rootCommentId,
    params.decision.commentId,
    params.decision.updatedAt,
  );
  const operationMarker = operationIntentMarker(operationKey, params.publish.workItemId);
  const retainedHead = intentIdentity(params.publish.publication.intent(operationKey)).headSha;
  if (typeof retainedHead === "string" && retainedHead !== params.publish.headSha) {
    throw new AppError({
      domain: "operation_intent",
      kind: "mutation_outcome_unknown",
      message: "Verification objection answer identity no longer matches its retained head",
      context: {
        workItemId: params.publish.workItemId,
        operationKey,
        unknownResolution: "terminal",
      },
    });
  }
  const commentId = await params.publish.publication.once<number>({
    decodeResult: (value) => {
      v.assert(v.pipe(v.number(), v.integer(), v.gtValue(0)), value);
      return value;
    },
    resourceTarget: `objection_answer:${params.decision.commentId}`,
    operationKey,
    mutationKind: "github.verification_objection_answer",
    identity: {
      rootCommentId: params.thread.rootCommentId,
      objectionCommentId: params.decision.commentId,
      updatedAt: params.decision.updatedAt,
      headSha: params.publish.headSha,
      resourceKey: params.publish.resourceKey,
      reviewLens: VERIFICATION_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      recoverObjectionAnswer({
        publication: params.publish.publication,
        resourceKey: params.publish.resourceKey,
        prSurface: params.publish.prSurface,
        rootCommentId: params.thread.rootCommentId,
        objectionCommentId: params.decision.commentId,
        updatedAt: params.decision.updatedAt,
      }),
    mutate: () =>
      params.publish.prSurface
        .replyAt(
          {
            kind: "inlineReviewThread",
            prNumber: params.publish.prNumber,
            inReplyToCommentId: params.thread.rootCommentId,
          },
          objectionAnswerBody(params.decision, params.verdict, params.objection, operationMarker),
        )
        .then((posted) => posted.commentId),
  });
  logInfo("verification_objection_answered", {
    workItemId: params.publish.workItemId,
    resourceKey: params.publish.resourceKey,
    rootCommentId: params.thread.rootCommentId,
    objectionCommentId: params.decision.commentId,
    answerCommentId: commentId,
  });
  return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(commentId);
}

async function postObjectionAnswers(params: {
  readonly publish: PublishVerificationParams;
  readonly thread: BotFindingThread;
  readonly verdict: VerificationVerdict;
  readonly decisions: readonly VerificationObjectionDecision[];
}) {
  const quiet = notObjectionEntries(params.decisions);
  const answers = params.decisions.flatMap((decision) =>
    decision.decision === "not_objection" ? [] : [decision],
  );
  if (answers.length === 0) {
    return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
      journal: quiet,
      revisionMoved: false,
      pageIncomplete: false,
      answered: 0,
      notObjection: quiet.length,
      skippedIncomplete: 0,
    });
  }
  const resolution = params.publish.resolutionByRootCommentId.get(params.thread.rootCommentId);
  if (resolution == null) {
    return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
      journal: quiet,
      revisionMoved: false,
      pageIncomplete: false,
      answered: 0,
      notObjection: quiet.length,
      skippedIncomplete: 0,
    });
  }
  const snapshot = await params.publish.prSurface.getReviewThread(resolution.threadNodeId);
  if (snapshot == null) {
    return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
      journal: [],
      revisionMoved: false,
      pageIncomplete: false,
      answered: 0,
      notObjection: 0,
      skippedIncomplete: 0,
    });
  }
  const confirmedQuiet = quiet.filter((entry) => {
    const live = snapshot.comments.find((comment) => comment.databaseId === entry.commentId);
    return live != null && live.updatedAt === entry.updatedAt;
  });
  if (!snapshot.commentsComplete) {
    return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
      journal: confirmedQuiet,
      revisionMoved: false,
      pageIncomplete: true,
      answered: 0,
      notObjection: confirmedQuiet.length,
      skippedIncomplete: answers.length,
    });
  }
  if (snapshot.isResolved) {
    return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
      journal: confirmedQuiet,
      revisionMoved: false,
      pageIncomplete: false,
      answered: 0,
      notObjection: confirmedQuiet.length,
      skippedIncomplete: 0,
    });
  }
  const objections = new Map(
    (params.thread.objections ?? []).map((objection) => [objection.commentId, objection]),
  );
  for (const decision of answers) {
    const live = snapshot.comments.find((comment) => comment.databaseId === decision.commentId);
    if (live != null && live.updatedAt !== decision.updatedAt) {
      return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
        journal: [],
        revisionMoved: true,
        pageIncomplete: false,
        answered: 0,
        notObjection: 0,
        skippedIncomplete: 0,
      });
    }
  }
  const botLogin = await params.publish.prSurface.getBotLogin();
  const journal: VerificationObjectionJournalEntry[] = [...confirmedQuiet];
  let answered = 0;
  for (const decision of answers) {
    const objection = objections.get(decision.commentId);
    const live = snapshot.comments.find((comment) => comment.databaseId === decision.commentId);
    if (objection == null || live == null) continue;
    const existing = existingAnswerCommentId(
      snapshot,
      botLogin,
      decision.commentId,
      decision.updatedAt,
    );
    if (existing != null) {
      journal.push({
        commentId: decision.commentId,
        updatedAt: decision.updatedAt,
        decision: decision.decision,
        answerCommentId: existing,
      });
      continue;
    }
    const answerCommentId = await publishObjectionAnswer({
      publish: params.publish,
      thread: params.thread,
      verdict: params.verdict,
      decision,
      objection,
    });
    answered += 1;
    journal.push({
      commentId: decision.commentId,
      updatedAt: decision.updatedAt,
      decision: decision.decision,
      answerCommentId,
    });
  }
  return ((pinnedReturn: ObjectionPostResult | Promise<ObjectionPostResult>) => pinnedReturn)({
    journal,
    revisionMoved: false,
    pageIncomplete: false,
    answered,
    notObjection: confirmedQuiet.length,
    skippedIncomplete: 0,
  });
}

export async function publishVerification(params: PublishVerificationParams) {
  const degradation = new Set<VerificationDegradationReason>();
  if (params.changedFilePathsTruncated === true) degradation.add("compare_files_truncated");
  let ledger = loadVerificationThreadLedger(params.publication.db, {
    resourceKey: params.resourceKey,
  });
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  const changedFiles = new Set(params.changedFilePaths);
  const changedMembershipComplete =
    params.changedMembershipComplete ?? params.changedFilePathsTruncated !== true;
  const objectionCounts: ObjectionPublishCounts = {
    answered: 0,
    notObjection: 0,
    skippedIncomplete: 0,
  };

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
        const findingId = thread.findingId;
        if (!resolution || findingId == null) {
          degradation.add("verdict_mapping_incomplete");
          break;
        }
        const priorStubId = resolveStubCommentId(thread, prior);
        const decisions = objectionDecisionsFor(thread, params.payload);
        const publishFixedResolution = async (
          receipt: string,
          operationMarker: string | undefined,
          accepted: () => void,
        ) => {
          let nextStubCommentId: number | undefined = priorStubId;
          if (priorStubId != null) {
            const updated = await updateStubReply({
              prSurface: params.prSurface,
              stubCommentId: priorStubId,
              body: `${terminalSuccessStubBody(verdict, operationMarker)}${receipt}`,
            });
            if (!updated) nextStubCommentId = undefined;
            else accepted();
          }
          if (
            nextStubCommentId == null &&
            (await appendRootResolutionReceipt(params.prSurface, {
              threadNodeId: resolution.threadNodeId,
              findingId,
              kind: "fixed",
            }))
          ) {
            accepted();
          }
          if (!resolution.isResolved) {
            await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
          }
          return nextStubCommentId;
        };

        const locked = await (async () => {
          const posted =
            decisions.length === 0
              ? null
              : await postObjectionAnswers({
                  publish: params,
                  thread,
                  verdict,
                  decisions,
                });
          if (posted?.revisionMoved) return { revisionMoved: true as const, posted };
          const receipt =
            priorStubId == null
              ? ""
              : ((await unpostedResolutionReceipt(params.prSurface, {
                  threadNodeId: resolution.threadNodeId,
                  findingId,
                  kind: "fixed",
                  ownCommentId: priorStubId,
                })) ?? "");
          const operation = await withVerificationThreadOperation(
            params,
            verdict,
            true,
            {
              requiresStub: priorStubId != null,
              stubCommentId: priorStubId,
              threadNodeId: resolution.threadNodeId,
              body: (marker) => `${terminalSuccessStubBody(verdict, marker)}${receipt}`,
            },
            (operationMarker, accepted) =>
              publishFixedResolution(receipt, operationMarker, accepted),
          );
          return { revisionMoved: false as const, posted, operation };
        })();
        if (locked.revisionMoved) break;
        if (locked.posted != null) {
          noteObjectionCounts(objectionCounts, locked.posted);
          if (locked.posted.pageIncomplete) degradation.add("objection_detection_incomplete");
        }
        ledger = await persistThreadState({
          publication: params.publication,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: withObjectionJournal(
            {
              ...terminalThreadState(
                prior,
                verdict.verdict,
                params.headSha,
                locked.operation.stubCommentId,
              ),
              completion: locked.operation.completion,
            },
            prior,
            locked.posted?.journal ?? [],
          ),
        });
        break;
      }
      case "skipped": {
        const decisions = objectionDecisionsFor(thread, params.payload);
        const hasAnswer = decisions.some((decision) => decision.decision !== "not_objection");
        const writesStub = !(changedMembershipComplete && !changedFiles.has(thread.path));
        if (!hasAnswer && !writesStub) {
          const journal = notObjectionEntries(decisions);
          if (journal.length > 0) {
            objectionCounts.notObjection += journal.length;
            ledger = await persistThreadState({
              publication: params.publication,
              workItemId: params.workItemId,
              resourceKey: params.resourceKey,
              ledger,
              rootCommentId: verdict.threadRootCommentId,
              state: journalOnlyState(prior, "skipped", journal),
            });
          }
          break;
        }
        const locked = await (async () => {
          const posted =
            decisions.length === 0
              ? null
              : await postObjectionAnswers({
                  publish: params,
                  thread,
                  verdict,
                  decisions,
                });
          if (posted?.revisionMoved || !writesStub) return { posted, operation: undefined };
          const operation = await withVerificationThreadOperation(
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
          return { posted, operation };
        })();
        if (locked.posted?.revisionMoved) break;
        if (locked.posted != null) {
          noteObjectionCounts(objectionCounts, locked.posted);
          if (locked.posted.pageIncomplete) degradation.add("objection_detection_incomplete");
        }
        if (locked.operation == null) {
          const journal = locked.posted?.journal ?? [];
          if (journal.length > 0) {
            ledger = await persistThreadState({
              publication: params.publication,
              workItemId: params.workItemId,
              resourceKey: params.resourceKey,
              ledger,
              rootCommentId: verdict.threadRootCommentId,
              state: journalOnlyState(prior, "skipped", journal),
            });
          }
          break;
        }
        ledger = await persistThreadState({
          publication: params.publication,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: withObjectionJournal(
            {
              stubCommentId: locked.operation.stubCommentId,
              lastVerdict: "skipped",
              lastHeadSha: params.headSha,
              completion: locked.operation.completion,
            },
            prior,
            locked.posted?.journal ?? [],
          ),
        });
        break;
      }
      case "dismissed": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        const findingId = thread.findingId;
        if (!resolution || findingId == null) {
          degradation.add("verdict_mapping_incomplete");
          break;
        }
        const priorStubId = resolveStubCommentId(thread, prior);
        const decisions = objectionDecisionsFor(thread, params.payload);
        const locked = await (async () => {
          const posted =
            decisions.length === 0
              ? null
              : await postObjectionAnswers({
                  publish: params,
                  thread,
                  verdict,
                  decisions,
                });
          if (posted?.revisionMoved) return { revisionMoved: true as const, posted };
          const receipt =
            (await unpostedResolutionReceipt(params.prSurface, {
              threadNodeId: resolution.threadNodeId,
              findingId,
              kind: "dismissed",
              ownCommentId: priorStubId,
            })) ?? "";
          const operation = await withVerificationThreadOperation(
            params,
            verdict,
            true,
            {
              requiresStub: true,
              stubCommentId: priorStubId,
              threadNodeId: resolution.threadNodeId,
              body: (marker) =>
                `${dismissedReplyBody(verdict, thread, params.policyResult, marker)}${receipt}`,
            },
            async (operationMarker, accepted) => {
              const createdStubCommentId = await upsertStubComment({
                prSurface: params.prSurface,
                prNumber: params.prNumber,
                thread,
                stubCommentId: priorStubId,
                body: `${dismissedReplyBody(verdict, thread, params.policyResult, operationMarker)}${receipt}`,
              });
              accepted();
              if (!resolution.isResolved) {
                await params.prSurface.resolveInlineReviewThread(resolution.threadNodeId);
              }
              return createdStubCommentId;
            },
          );
          return { revisionMoved: false as const, posted, operation };
        })();
        if (locked.revisionMoved) break;
        if (locked.posted != null) {
          noteObjectionCounts(objectionCounts, locked.posted);
          if (locked.posted.pageIncomplete) degradation.add("objection_detection_incomplete");
        }
        ledger = await persistThreadState({
          publication: params.publication,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: withObjectionJournal(
            {
              ...terminalThreadState(
                prior,
                "dismissed",
                params.headSha,
                locked.operation.stubCommentId,
              ),
              completion: locked.operation.completion,
            },
            prior,
            locked.posted?.journal ?? [],
          ),
        });
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

  return ((pinnedReturn: VerificationPublishResult | Promise<VerificationPublishResult>) =>
    pinnedReturn)({
    degradation: [...degradation],
    ...(objectionCounts.answered > 0 ? { objectionsAnswered: objectionCounts.answered } : {}),
    ...(objectionCounts.notObjection > 0
      ? { objectionsNotObjection: objectionCounts.notObjection }
      : {}),
    ...(objectionCounts.skippedIncomplete > 0
      ? { objectionsSkippedIncomplete: objectionCounts.skippedIncomplete }
      : {}),
  });
}
