import crypto from "node:crypto";
import type {
  AcknowledgementTarget,
  PrSurface,
  PrSurfaceMutation,
  PrSurfaceMutationBoundary,
  ReviewCheckOutcome,
  ReviewCommitStatusParams,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
import type { ReplyTarget } from "../commands/replyTarget.js";
import type { DescriptionPayload } from "../agent/description/descriptionSchema.js";
import type { GithubReactionContent } from "../settings/index.js";

const wrappedBoundaries = new WeakMap<PrSurface, PrSurfaceMutationBoundary>();

function inputHash(input: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(input, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    );
  } catch {
    encoded = String(input);
  }
  return crypto
    .createHash("sha256")
    .update(encoded ?? "undefined")
    .digest("hex")
    .slice(0, 32);
}

function mutation(method: string, input: unknown): PrSurfaceMutation {
  const hash = inputHash(input);
  return {
    operationKey: `pr-surface:${method}:${hash}`,
    mutationKind: `github.pr_surface.${method}`,
    detail: {
      surfaceMethod: method,
      inputHash: hash,
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("PR-surface mutation aborted");
}

/**
 * Wrap every mutating method at the PR-surface seam. The implementation and
 * fake share this wrapper so tests exercise the same fence as production.
 */
export function withPrSurfaceMutationBoundary(
  surface: PrSurface,
  boundary: PrSurfaceMutationBoundary,
): PrSurface {
  if (wrappedBoundaries.get(surface) === boundary) return surface;

  const run = <T>(method: string, input: unknown, mutate: () => Promise<T>): Promise<T> => {
    throwIfAborted(boundary.signal);
    return boundary.run(mutation(method, input), async () => {
      throwIfAborted(boundary.signal);
      return mutate();
    });
  };

  const wrapped: PrSurface = {
    ...surface,
    async setAcknowledgementReaction(
      targets: readonly AcknowledgementTarget[],
      kind: GithubReactionContent,
    ) {
      return run("setAcknowledgementReaction", { targets, kind }, () =>
        surface.setAcknowledgementReaction(targets, kind),
      );
    },
    async replyAt(target: ReplyTarget, body: string) {
      return run("replyAt", { target, body }, () => surface.replyAt(target, body));
    },
    async upsertProgressComment(body: string, sentinel: string, knownExisting) {
      return run(
        "upsertProgressComment",
        { body, sentinel, knownExistingId: knownExisting?.id ?? null },
        () => surface.upsertProgressComment(body, sentinel, knownExisting),
      );
    },
    async editComment(commentId: number, body: string) {
      return run("editComment", { commentId, body }, () => surface.editComment(commentId, body));
    },
    async setReviewCommitStatus(headSha: string, params: ReviewCommitStatusParams) {
      return run("setReviewCommitStatus", { headSha, params }, () =>
        surface.setReviewCommitStatus(headSha, params),
      );
    },
    async publishThreadBatch(review: ThreadBatchReview) {
      return run("publishThreadBatch", review, () => surface.publishThreadBatch(review));
    },
    async resolveInlineReviewThread(threadId: string) {
      return run("resolveInlineReviewThread", { threadId }, () =>
        surface.resolveInlineReviewThread(threadId),
      );
    },
    async setLabels(labels: readonly string[]) {
      return run("setLabels", { labels }, () => surface.setLabels(labels));
    },
    async startReviewCheck(headSha: string, externalId: string, summary?: string) {
      return run("startReviewCheck", { headSha, externalId, summary }, () =>
        surface.startReviewCheck(headSha, externalId, summary),
      );
    },
    async finishReviewCheck(outcome: ReviewCheckOutcome) {
      return run("finishReviewCheck", outcome, () => surface.finishReviewCheck(outcome));
    },
    async editReviewComment(commentId: number, body: string) {
      return run("editReviewComment", { commentId, body }, () =>
        surface.editReviewComment(commentId, body),
      );
    },
    async publishDescription(
      cfg: Parameters<PrSurface["publishDescription"]>[0],
      payload: DescriptionPayload,
    ) {
      return run("publishDescription", { features: cfg.features, payload }, () =>
        surface.publishDescription(cfg, payload),
      );
    },
  };
  wrappedBoundaries.set(surface, boundary);
  wrappedBoundaries.set(wrapped, boundary);
  return wrapped;
}
