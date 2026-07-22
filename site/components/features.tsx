import { Section } from "@/components/section";
import { FEATURES } from "@/lib/content";

export function Features() {
  return (
    <Section id="features" labelledBy="features-heading">
      <header className="max-w-2xl border-b border-edge pb-10">
        <h2
          id="features-heading"
          className="font-display text-[clamp(2.1rem,4.2vw,3.25rem)] leading-[1.05] tracking-[-0.02em] text-ink"
        >
          How a pull request gets its first pass
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-mute sm:text-[1.05rem]">
          One deploy. After that, every PR follows the same path inside GitHub - no extra dashboard,
          no per-seat bill from PR Agent.
        </p>
      </header>

      <ol className="mt-2">
        {FEATURES.map((feature, index) => {
          const step = String(index + 1).padStart(2, "0");
          const isLast = index === FEATURES.length - 1;
          return (
            <li
              key={feature.title}
              className={
                isLast
                  ? "grid gap-3 py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]"
                  : "grid gap-3 border-b border-edge py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]"
              }
            >
              <p
                aria-hidden="true"
                className="font-display text-[clamp(2.5rem,5vw,3.5rem)] leading-none tracking-[-0.03em] text-sky/45"
              >
                {step}
              </p>
              <div className="min-w-0 max-w-2xl">
                <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
                  {feature.title}
                </h3>
                <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
                  {feature.detail}
                </p>
                <p className="mt-4 font-mono text-[0.8rem] leading-snug text-bolt sm:text-[0.85rem]">
                  {feature.cue}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
