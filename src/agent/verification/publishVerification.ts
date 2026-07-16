import type { Pool } from "pg";
import { installationOctokit } from "../../github/appAuth.js";
import {
  resolveReviewThread,
  type ReviewThreadResolution,
} from "../../github/reviewThreadResolution.js";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.js";
import { renderPolicySuggestionForDismissed } from "../../review/repoPolicy.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { VerificationPayload, VerificationVerdict } from "../../review/triageSchema.js";
import { VERIFICATION_PUBLISH_LENS } from "../../settings/index.js";
import {
  loadActedThreadIds,
  recordActedThreadIds,
} from "../../agentWork/threadActionCheckpoint.js";

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
};

function skippedReplyBody(verdict: Extract<VerificationVerdict, { verdict: "skipped" }>): string {
  return redactReviewText(`**Verification**: still open - ${verdict.reason}`);
}

function dismissedReplyBody(
  verdict: Extract<VerificationVerdict, { verdict: "dismissed" }>,
  thread: BotFindingThread,
): string {
  const evidence = redactReviewText(`**Verification**: dismissed - ${verdict.evidence}`);
  const suggestion = renderPolicySuggestionForDismissed({
    filePath: thread.path,
    dismissalEvidence: verdict.evidence,
  });
  return `${evidence}\n\nSuggested policy entry:\n\n${suggestion}`;
}

async function replyToThread(
  params: Pick<
    PublishVerificationParams,
    "token" | "tokenExpiresAtTs" | "owner" | "repo" | "prNumber"
  > & {
    readonly thread: BotFindingThread;
    readonly body: string;
  },
): Promise<void> {
  const octokit = installationOctokit(params.token, params.tokenExpiresAtTs);
  await octokit.rest.pulls.createReplyForReviewComment({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    comment_id: params.thread.rootCommentId,
    body: params.body,
  });
}

export async function publishVerification(
  params: PublishVerificationParams,
): Promise<{ degraded: boolean }> {
  let degraded = false;
  const actedThreadIds = new Set(
    await loadActedThreadIds(params.pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: VERIFICATION_PUBLISH_LENS,
      step: "verification_thread_actions",
    }),
  );
  const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
  const changedFiles = new Set(params.changedFilePaths);

  for (const verdict of params.payload.verdicts) {
    const thread = threadById.get(verdict.threadRootCommentId);
    if (!thread) {
      degraded = true;
      continue;
    }

    if (verdict.verdict === "fixed" || verdict.verdict === "already-resolved") {
      const resolution = params.resolutionByRootCommentId.get(verdict.threadRootCommentId);
      if (!resolution) {
        degraded = true;
        continue;
      }
      if (resolution.isResolved) continue;
      if (!actedThreadIds.has(verdict.threadRootCommentId)) {
        actedThreadIds.add(verdict.threadRootCommentId);
        await recordActedThreadIds(params.pool, {
          workItemId: params.workItemId,
          resourceKey: params.resourceKey,
          reviewLens: VERIFICATION_PUBLISH_LENS,
          step: "verification_thread_actions",
          actedThreadIds: [...actedThreadIds],
        });
      }
      await resolveReviewThread(params.token, resolution.threadNodeId, params.tokenExpiresAtTs);
    } else if (verdict.verdict === "skipped") {
      if (!changedFiles.has(thread.path)) continue;
      if (actedThreadIds.has(verdict.threadRootCommentId)) continue;
      const body = skippedReplyBody(verdict);
      actedThreadIds.add(verdict.threadRootCommentId);
      await recordActedThreadIds(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: VERIFICATION_PUBLISH_LENS,
        step: "verification_thread_actions",
        actedThreadIds: [...actedThreadIds],
      });
      await replyToThread({ ...params, thread, body });
    } else if (verdict.verdict === "dismissed") {
      if (actedThreadIds.has(verdict.threadRootCommentId)) continue;
      const body = dismissedReplyBody(verdict, thread);
      actedThreadIds.add(verdict.threadRootCommentId);
      await recordActedThreadIds(params.pool, {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: VERIFICATION_PUBLISH_LENS,
        step: "verification_thread_actions",
        actedThreadIds: [...actedThreadIds],
      });
      await replyToThread({ ...params, thread, body });
    }
  }

  return { degraded };
}
