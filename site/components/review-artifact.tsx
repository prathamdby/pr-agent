import { GhCode } from "@/components/github-output/primitives";

export function ReviewArtifact() {
  return (
    <div className="relative w-full" aria-hidden="true">
      <div className="chamfer surface-panel edge-self relative overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2.5 sm:px-4">
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-ink-mute">prathamdby/pr-agent#284</p>
            <p className="mt-0.5 truncate text-sm text-ink-soft">
              Route env knobs through settings
            </p>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-sky">open</span>
        </div>

        <div className="space-y-2.5 px-3 py-3 sm:px-4 sm:py-3.5">
          <div className="surface-inset edge-self px-2.5 py-2">
            <p className="font-mono text-[11px] text-bolt">/review</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              First-pass review posted. Two findings on the Files changed tab.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[11px] text-bolt">P1 · c4</span>
              <span className="font-mono text-[11px] text-ink-faint">
                src/webhooks/intake.ts:148
              </span>
            </div>
            <p className="text-xs leading-relaxed text-ink-soft">
              Webhook ack can race the durable write on concurrent deliveries.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[11px] text-bolt">P2 · c3</span>
              <span className="font-mono text-[11px] text-ink-faint">src/review/publish.ts:91</span>
            </div>
            <p className="text-xs leading-relaxed text-ink-soft">
              Summary comment edit path ignores a stale head SHA guard.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[11px] text-bolt">P2 · c3</span>
              <span className="font-mono text-[11px] text-ink-faint">
                src/agentWork/lease.ts:77
              </span>
            </div>
            <p className="text-xs leading-relaxed text-ink-soft">
              Lease renew can write after the epoch fence has already moved.
            </p>
          </div>

          <div className="surface-inset edge-self px-2.5 py-2">
            <p className="font-mono text-[11px] text-ink-mute">## PR Agent Review</p>
            <p className="mt-1 text-xs text-ink-soft">
              Size <GhCode>M</GhCode>. Fix the intake race before merge.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
