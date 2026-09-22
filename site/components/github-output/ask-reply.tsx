import { GhComment, GhLabel } from "@/components/github-output/primitives";

/** Pull request conversation reply from `formatAskReply`: Question, then Answer. */
export function AskReplyMock() {
  return (
    <GhComment surface="Pull request conversation reply" frame="window">
      <div className="space-y-3 text-[13px] leading-relaxed">
        <p className="text-text-secondary">
          <span className="font-semibold text-text">Question:</span> Why is the retry wrapper needed
          around the webhook dispatcher?
        </p>
        <div>
          <GhLabel>Answer:</GhLabel>
          <p className="mt-1.5 text-text-secondary">
            Transient GitHub 502s were dropping webhook deliveries before durable intake completed.
            The retry wrapper keeps the delivery alive long enough for the Postgres write and
            acknowledgement reaction to finish, then the worker picks up the agent work item.
          </p>
          <p className="mt-2 text-text-secondary">
            Without it, a delivery that failed on the first attempt was gone for good. GitHub does
            not redeliver on its own, so the pull request stayed quiet even though the webhook had
            been accepted.
          </p>
        </div>
      </div>
    </GhComment>
  );
}
