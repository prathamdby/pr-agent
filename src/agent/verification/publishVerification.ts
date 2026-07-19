import type { Pool } from "pg";
import { installationOctokit } from "../../github/appAuth.js";
import { httpStatus } from "../../github/httpStatus.js";
import {
  resolveReviewThread,
  type ReviewThreadResolution,
} from "../../github/reviewThreadResolution.js";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.js";
import {
  renderPolicySuggestionForDismissed,
  type RepoPolicyResult,
} from "../../review/repoPolicy.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { VerificationPayload, VerificationVerdict } from "../../review/triageSchema.js";
import { VERIFICATION_STUB_MARKER } from "../../settings/index.js";
import {
  loadVerificationThreadLedger,
  saveVerificationThreadLedger,
  upsertVerificationThreadState,
  type VerificationThreadLedger,
  type VerificationThreadState,
} from "../../agentWork/verificationThreadLedger.js";

type PublishVerificationParams = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly inventory: readonly BotFindingThread[];
  readonly resolutionByRootCommentId: ReadonlyMap<number, ReviewThreadResolution>;
  readonly payload: VerificationPayload;
  readonly changedFilePaths: readonly string[];
  readonly policyResult: RepoPolicyResult;
};

function withStubMarker(body: string): string {
  if (body.includes(VERIFICATION_STUB_MARKER)) return body;
  return `${VERIFICATION_STUB_MARKER}\n${body}`;
}

function skippedReplyBody(verdict: Extract<VerificationVerdict, { verdict: "skipped" }>): string {
  return withStubMarker(redactReviewText(`**Verification**: still open - ${verdict.reason}`));
}

function dismissedReplyBody(
  verdict: Extract<VerificationVerdict, { verdict: "dismissed" }>,
  thread: BotFindingThread,
  policyResult: RepoPolicyResult,
): string {
  const evidence = redactReviewText(`**Verification**: dismissed - ${verdict.evidence}`);
  const suggestion = renderPolicySuggestionForDismissed({
    filePath: thread.path,
    dismissalEvidence: verdict.evidence,
    policyResult,
  });
  return withStubMarker(`${evidence}\n\nSuggested policy entry:\n\n${suggestion}`);
}

function resolveStubCommentId(
  thread: BotFindingThread,
  state: VerificationThreadState | undefined,
): number | undefined {
  return state?.stubCommentId ?? thread.verificationStubCommentId;
}

async function createStubReply(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly body: string;
}): Promise<number> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  const { data } = await octokit.rest.pulls.createReplyForReviewComment({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    comment_id: params.thread.rootCommentId,
    body: params.body,
  });
  return data.id;
}

async function updateStubReply(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly stubCommentId: number;
  readonly body: string;
}): Promise<boolean> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  try {
    await octokit.rest.pulls.updateReviewComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.stubCommentId,
      body: params.body,
    });
    return true;
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}

async function upsertStubComment(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly thread: BotFindingThread;
  readonly stubCommentId: number | undefined;
  readonly body: string;
}): Promise<number> {
  if (params.stubCommentId != null) {
    const updated = await updateStubReply({
      token: params.token,
      tokenExpiresAtTs: params.tokenExpiresAtTs,
      owner: params.owner,
      repo: params.repo,
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
}): Promise<VerificationThreadLedger> {
  const next = upsertVerificationThreadState(params.ledger, params.rootCommentId, params.state);
  await saveVerificationThreadLedger(params.pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    ledger: next,
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

export async function publishVerification(
  params: PublishVerificationParams,
): Promise<{ degraded: boolean }> {
  let degraded = false;
  let ledger = await loadVerificationThreadLedger(params.pool, {
    resourceKey: params.resourceKey,
  });
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  const changedFiles = new Set(params.changedFilePaths);

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
        if (!resolution.isResolved) {
          await resolveReviewThread(params.token, resolution.threadNodeId, params.tokenExpiresAtTs);
        }
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: terminalThreadState(prior, verdict.verdict, params.headSha),
        });
        break;
      }
      case "skipped": {
        if (!changedFiles.has(thread.path)) break;
        const body = skippedReplyBody(verdict);
        const stubCommentId = await upsertStubComment({
          token: params.token,
          tokenExpiresAtTs: params.tokenExpiresAtTs,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          thread,
          stubCommentId: resolveStubCommentId(thread, prior),
          body,
        });
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: {
            stubCommentId,
            lastVerdict: "skipped",
            lastHeadSha: params.headSha,
          },
        });
        break;
      }
      case "dismissed": {
        const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
        if (!resolution) {
          degraded = true;
          break;
        }
        const body = dismissedReplyBody(verdict, thread, params.policyResult);
        const stubCommentId = await upsertStubComment({
          token: params.token,
          tokenExpiresAtTs: params.tokenExpiresAtTs,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          thread,
          stubCommentId: resolveStubCommentId(thread, prior),
          body,
        });
        if (!resolution.isResolved) {
          await resolveReviewThread(params.token, resolution.threadNodeId, params.tokenExpiresAtTs);
        }
        ledger = await persistThreadState({
          pool: params.pool,
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          ledger,
          rootCommentId: verdict.threadRootCommentId,
          state: terminalThreadState(prior, "dismissed", params.headSha, stubCommentId),
        });
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
