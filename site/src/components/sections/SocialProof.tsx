import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";
import { STATS, TESTIMONIALS } from "@/content";

export function SocialProof() {
  return (
    <section className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
      <Reveal>
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 border-y border-border py-12 lg:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center lg:text-left">
              <div className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                {stat.value}
              </div>
              <p className="mx-auto mt-2 max-w-[24ch] text-sm leading-snug text-fg-dim lg:mx-0">
                {stat.label}
              </p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal>
        <h2 className="mt-20 max-w-[20ch] text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
          Teams keep it because it earns its place quietly.
        </h2>
      </Reveal>

      <Stagger className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2" gap={0.08}>
        {TESTIMONIALS.map((t) => (
          <StaggerItem key={t.name}>
            <figure className="flex h-full flex-col rounded-[var(--radius)] border border-border bg-surface/60 p-7">
              <blockquote className="text-pretty text-lg leading-relaxed text-fg">
                {t.quote}
              </blockquote>
              <figcaption className="mt-7 flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full border border-border-hi bg-bg-soft font-mono text-sm font-medium text-accent">
                  {t.initials}
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-medium text-fg">{t.name}</span>
                  <span className="block text-sm text-fg-dim">{t.role}</span>
                </span>
              </figcaption>
            </figure>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
