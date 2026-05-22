export type ReplyTarget =
  | { readonly kind: "prConversation"; readonly prNumber: number }
  | {
      readonly kind: "inlineReviewThread";
      readonly prNumber: number;
      readonly inReplyToCommentId: number;
    };
