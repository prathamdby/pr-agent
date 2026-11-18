import type { ReviewThreadResolution } from "../../src/github/reviewThreadResolution.ts";
import { createFakePrSurface, type FakePrSurfaceControls } from "../../src/github/prSurface.ts";

export function publishTestPrSurface(
  threads: ReadonlyMap<number, ReviewThreadResolution> = new Map([
    [1, { threadNodeId: "node", isResolved: false }],
  ]),
) {
  const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  fake.controls.setThreads(new Map(threads));
  return fake;
}

export function upsertProgressBody(controls: FakePrSurfaceControls) {
  const event = controls.events
    .toReversed()
    .find((entry) => entry.kind === "upsertProgressComment");
  return ((pinnedReturn: string) => pinnedReturn)(
    event?.kind === "upsertProgressComment" ? event.body : "",
  );
}

export function resolveThreadIds(controls: FakePrSurfaceControls) {
  return ((pinnedReturn: string[]) => pinnedReturn)(
    controls.events.flatMap((entry) =>
      entry.kind === "resolveInlineReviewThread" ? [entry.threadId] : [],
    ),
  );
}

export function editReviewCommentEvents(controls: FakePrSurfaceControls) {
  return ((pinnedReturn: Array<{ commentId: number; body: string }>) => pinnedReturn)(
    controls.events.flatMap((entry) =>
      entry.kind === "editReviewComment" ? [{ commentId: entry.commentId, body: entry.body }] : [],
    ),
  );
}
