import { CAPABILITIES } from "@/lib/content";

function commandHint(trigger: string): string | null {
  const match = trigger.match(/\/[a-z-]+/);
  return match?.[0] ?? null;
}

export function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="bg-navy-raised px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <h2
            id="capabilities-heading"
            className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
          >
            What your team gets back in GitHub
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-mute">
            Trigger a pass from a pull request comment, or let the automatic path run when a PR
            opens or updates.
          </p>
        </div>

        <ul className="mt-12 max-w-2xl space-y-9">
          {CAPABILITIES.map((cap) => {
            const command = commandHint(cap.trigger);
            return (
              <li key={cap.title} className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {command ? (
                    <span className="font-mono text-sm text-bolt">{command}</span>
                  ) : (
                    <span className="font-mono text-sm text-sky">automatic</span>
                  )}
                  <span className="text-xs text-ink-faint">{cap.trigger}</span>
                </div>
                <h3 className="mt-2 text-base font-medium leading-snug text-ink sm:text-lg">
                  {cap.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-mute">{cap.detail}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
