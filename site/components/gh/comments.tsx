import { CaretRightIcon } from "@phosphor-icons/react";
import {
  BotAvatar,
  GhCode,
  GhComment,
  GhLabel,
  GhNote,
  GhRow,
  GhTable,
} from "@/components/gh/primitives";

/* All content below is invented. It mirrors the shape of what PR Agent posts, not real text. */

export function ReviewComment() {
  return (
    <GhComment author="pr-agent" bot when="3 hours ago" avatar={<BotAvatar />}>
      <p className="text-[17px] font-semibold leading-tight">PR Agent Review</p>
      <GhNote>
        1 finding blocks merge. CI is green. All four specialists ran with full coverage.
      </GhNote>
      <GhTable>
        <GhRow label="Size">
          <GhCode>M</GhCode>
        </GhRow>
        <GhRow label="P1 · c4">
          <span className="font-semibold underline" style={{ color: "var(--gh-link)" }}>
            Retry loop re-enqueues a delivery after its lease has already expired
          </span>
          <p className="italic">
            On the diff · <GhCode>src/webhooks/retryDispatcher.ts</GhCode> · lines 112-128
          </p>
          <p className="italic">Fix prompt on the inline thread.</p>
        </GhRow>
        <GhRow label="CI">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: "var(--gh-success)" }} />3 of
            3 checks passed
          </span>
        </GhRow>
        <GhRow label="Mergeability">
          Two-way: one file, no schema change. Reverting drops the retry path and nothing else.
        </GhRow>
        <GhRow label="Blast radius" last>
          Contained to webhook intake. A duplicate enqueue would double-post one review comment per
          affected pull request.
        </GhRow>
      </GhTable>
      <p className="flex items-center gap-1.5">
        <CaretRightIcon weight="fill" className="size-3" />
        Fix all findings (agent prompt)
      </p>
      <p className="text-[11px]" style={{ color: "var(--gh-muted)" }}>
        <GhCode>a41f0c2</GhCode> · review · 4m 18s · claude-sonnet-5
      </p>
    </GhComment>
  );
}

export function DescribeComment() {
  return (
    <GhComment author="pr-agent" bot when="just now" avatar={<BotAvatar />}>
      <p className="text-[17px] font-semibold leading-tight">PR Agent Description</p>
      <div>
        <p className="font-semibold">PR type</p>
        <p className="mt-1 flex gap-1.5">
          <GhLabel tone="done">Bug fix</GhLabel>
          <GhLabel tone="attention">Reliability</GhLabel>
        </p>
      </div>
      <div>
        <p className="font-semibold">Description</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Wrap the webhook dispatcher in a bounded retry with jittered backoff.</li>
          <li>
            Skip retries once the actor lease has expired, so a stale worker cannot double-post.
          </li>
          <li>Record each attempt on the delivery row for the recovery runbook.</li>
        </ul>
      </div>
      <div>
        <p className="font-semibold">Changes diagram</p>
        <pre
          className="mt-1 overflow-x-auto rounded-[6px] p-3 font-mono text-[12px]"
          style={{ background: "var(--gh-subtle)" }}
        >
          {
            "flowchart LR\n  Webhook --> Intake --> Retry{lease alive?}\n  Retry -- yes --> Queue\n  Retry -- no --> Drop"
          }
        </pre>
      </div>
      <p className="flex items-center gap-1.5">
        <CaretRightIcon weight="fill" className="size-3" />
        File walkthrough (3 files)
      </p>
    </GhComment>
  );
}

export function AskComment() {
  return (
    <GhComment author="pr-agent" bot when="just now" avatar={<BotAvatar />}>
      <p>
        <span className="font-semibold">Question:</span> Why does the retry stop when the lease
        expires instead of re-acquiring it?
      </p>
      <div>
        <p className="font-semibold">Answer</p>
        <p className="mt-1">
          The lease epoch fences stale workers. If this worker re-acquired after expiry, a second
          worker could already hold the PR and both would publish. Dropping the delivery is safe
          because the deferred-delivery sweep re-enqueues it once the lease is free, see{" "}
          <GhCode>src/agentWork/deferredDeliveries.ts</GhCode>.
        </p>
      </div>
    </GhComment>
  );
}

export function TriageComment() {
  return (
    <GhComment author="pr-agent" bot when="just now" avatar={<BotAvatar />}>
      <p className="text-[17px] font-semibold leading-tight">PR Agent Triage</p>
      <p>
        Full PR triage. Evaluated head <GhCode>c91e7ad</GhCode>.
      </p>
      <p className="flex flex-wrap gap-1.5">
        <GhLabel tone="success">1 fixed</GhLabel>
        <GhLabel>1 already resolved</GhLabel>
        <GhLabel tone="attention">0 dismissed</GhLabel>
      </p>
      <GhTable>
        <GhRow label="P1">
          Retry loop re-enqueues after lease expiry
          <p style={{ color: "var(--gh-muted)" }}>
            <GhCode>src/webhooks/retryDispatcher.ts</GhCode> L112 · Fixed in{" "}
            <GhCode>7d02b4e</GhCode>
          </p>
        </GhRow>
        <GhRow label="P2" last>
          Attempt counter not reset on success
          <p style={{ color: "var(--gh-muted)" }}>
            <GhCode>src/webhooks/retryDispatcher.ts</GhCode> L140 · Already resolved
          </p>
        </GhRow>
      </GhTable>
      <p className="text-[11px]" style={{ color: "var(--gh-muted)" }}>
        Pushed <GhCode>7d02b4e</GhCode> Fix lease check in retry loop (1 file, +9 -2)
      </p>
    </GhComment>
  );
}
