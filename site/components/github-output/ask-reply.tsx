import { OutputFrame } from "@/components/github-output/primitives";

/** PR-conversation ask reply from `formatAskReply` (Question / Answer chrome). */
export function AskReplyMock() {
  return (
    <OutputFrame surface="PR conversation reply">
      <div className="space-y-3 text-xs leading-relaxed sm:text-sm">
        <p className="text-ink-soft">
          <span className="font-semibold text-ink">Question:</span> Why is the retry wrapper needed
          around the webhook dispatcher?
        </p>
        <div>
          <p className="font-semibold text-ink">Answer:</p>
          <p className="mt-1.5 text-ink-mute">
            Transient GitHub 502s were dropping webhook deliveries before durable intake completed.
            The retry wrapper keeps the delivery alive long enough for the Postgres write and
            acknowledgement reaction to finish, then the worker picks up the agent work item.
          </p>
        </div>
        <p className="text-ink-mute">
          On an inline review thread the same answer posts as plain text with no Question/Answer
          chrome.
        </p>
      </div>
    </OutputFrame>
  );
}
