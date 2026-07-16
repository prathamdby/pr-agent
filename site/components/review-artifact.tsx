const FINDINGS = [
  {
    severity: "P1",
    file: "src/webhooks/intake.ts",
    line: "148",
    note: "Webhook ack can race the durable write on concurrent deliveries.",
  },
  {
    severity: "P2",
    file: "src/review/publish.ts",
    line: "91",
    note: "Summary comment edit path ignores a stale head SHA guard.",
  },
] as const;

export function ReviewArtifact() {
  return (
    <div className="relative w-full origin-bottom-right" aria-hidden="true">
      <div className="chamfer surface-panel edge-self relative overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-ink-mute">prathamdby/pr-agent#284</p>
            <p className="mt-0.5 truncate text-sm text-ink-soft">Route env knobs through settings</p>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-moss">open</span>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="surface-inset edge-self px-3 py-2.5">
            <p className="font-mono text-[11px] text-moss">/review</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              First-pass review posted. Two findings on the Files changed tab.
            </p>
          </div>

          {FINDINGS.map((finding) => (
            <div key={finding.file + finding.line} className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[11px] text-moss-glow">{finding.severity}</span>
                <span className="font-mono text-[11px] text-ink-faint">
                  {finding.file}:{finding.line}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-ink-soft">{finding.note}</p>
            </div>
          ))}

          <div className="surface-inset edge-self px-3 py-2.5">
            <p className="font-mono text-[11px] text-ink-mute">## PR Agent Review</p>
            <p className="mt-1 text-xs text-ink-soft">
              Merge verdict <span className="text-ink">6/10</span> on this pass. Fix the intake race
              before merge.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
