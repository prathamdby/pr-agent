import type { AckTarget, AgentWorkItem } from "./types.js";

/** Prefer persisted intake targets; otherwise rebuild from PR + known comment fields. */
export function reactionTargetsForWorkItem(item: AgentWorkItem): readonly AckTarget[] {
  const stored = item.payload.ackTargets;
  if (stored != null && stored.length > 0) return stored;

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
      return exhaustive;
    }
  }
  return targets;
}
