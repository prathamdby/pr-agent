import { CAPABILITIES } from "@/lib/content";

export function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="bg-forge-raised px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <h2
          id="capabilities-heading"
          className="max-w-[22ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          What your team gets back in GitHub
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-mute">
          Trigger a pass from a pull request comment, or let the automatic path run when a PR opens
          or updates.
        </p>

        <ul className="mt-12 divide-y divide-edge border-y border-edge">
          {CAPABILITIES.map((cap) => (
            <li
              key={cap.title}
              className="grid gap-3 py-7 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-8 md:py-8"
            >
              <h3 className="text-base font-medium leading-snug text-ink md:text-lg">{cap.title}</h3>
              <p className="font-mono text-[12px] leading-relaxed text-moss md:pt-1">{cap.trigger}</p>
              <p className="text-sm leading-relaxed text-ink-mute md:pt-1">{cap.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
