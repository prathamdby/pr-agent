import type { AckTarget, AgentWorkItem } from "./types.ts";

export function reactionTargetsForWorkItem(item: AgentWorkItem) {
  const stored = item.payload.ackTargets;
  if (stored != null && stored.length > 0)
    return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)(stored);

  const targets: AckTarget[] = [{ kind: "pr", prNumber: item.prNumber }];
  switch (item.type) {
    case "ask":
    case "triage": {
      const commentId = item.payload.commentId;
      if (item.payload.replyTarget.kind === "inlineReviewThread") {
        targets.push({ kind: "reviewComment", commentId });
      } else {
        targets.push({ kind: "issueComment", commentId });
      }
      break;
    }
    case "review":
    case "description":
    case "verification":
      break;
    default: {
      const exhaustive: never = item;
      return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)(exhaustive);
    }
  }
  return ((pinnedReturn: readonly AckTarget[]) => pinnedReturn)(targets);
}
