import { Section } from "@/components/section";
import { CAPABILITIES } from "@/lib/content";

export function Capabilities() {
  return (
    <Section id="capabilities" labelledBy="capabilities-heading" raised>
      <div className="max-w-2xl">
        <h2
          id="capabilities-heading"
          className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          What your team gets back in GitHub
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-ink-mute">
          Trigger a pass from a pull request comment, or let the automatic path run when a PR opens.
        </p>
      </div>

      <ul className="mt-12 grid gap-x-12 gap-y-9 md:grid-cols-2">
        {CAPABILITIES.map((cap) => {
          const command = cap.trigger.match(/\/[a-z-]+/)?.[0] ?? null;
          return (
            <li key={cap.title} className="min-w-0">
              {command ? (
                <p className="font-mono text-sm text-bolt">{command}</p>
              ) : (
                <p className="font-mono text-sm text-sky">automatic</p>
              )}
              <h3 className="mt-2 text-base font-medium leading-snug text-ink sm:text-lg">
                {cap.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-mute">{cap.detail}</p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
