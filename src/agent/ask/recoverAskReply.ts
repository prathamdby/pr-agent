import type { ReplyTarget } from "../../commands/replyTarget.js";
import { installationOctokit } from "../../github/appAuth.js";
import { redactOutboundSecrets } from "./askSafety.js";

export type RecoveredAskReply = {
  readonly commentId: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

/** Extract a stashed GitHub comment id from operation-intent detail. */
export function askReplyCommentIdFromIntentDetail(
  detail: Record<string, unknown> | undefined,
): number | null {
  if (!detail || !("__result" in detail)) return null;
  const result = detail.__result;
  if (!isRecord(result)) return null;
  return typeof result.commentId === "number" ? result.commentId : null;
}

export function askReplyBodyMatchesQuestion(
  body: string,
  question: string,
  replyTarget: ReplyTarget,
): boolean {
  if (replyTarget.kind === "inlineReviewThread") {
    // Inline replies are answer-only; shape matching is not reliable.
    return false;
  }
  const redactedQuestion = redactOutboundSecrets(question.trim());
  if (!redactedQuestion) return false;
  return body.includes(`**Question:** ${redactedQuestion}`) && body.includes("**Answer:**");
}

/**
 * When local intent/publish state is ambiguous, look for an already-posted ask
 * reply on the PR conversation before remutating or rerunning the model.
 */
export async function findExistingAskReplyComment(params: {
  readonly token: string;
  readonly tokenExpiresAtTs?: number;
  readonly owner: string;
  readonly repo: string;
  readonly replyTarget: ReplyTarget;
  readonly question: string;
  readonly botLogin: string;
}): Promise<RecoveredAskReply | null> {
  const { token, tokenExpiresAtTs, owner, repo, replyTarget, question, botLogin } = params;
  if (replyTarget.kind === "inlineReviewThread") {
    return null;
  }

  const octokit = installationOctokit(token, tokenExpiresAtTs);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: replyTarget.prNumber,
    per_page: 100,
  });

  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (!comment || comment.user?.login !== botLogin) continue;
    if (!askReplyBodyMatchesQuestion(comment.body ?? "", question, replyTarget)) continue;
    return { commentId: comment.id };
  }
  return null;
}
