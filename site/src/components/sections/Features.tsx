import { type Icon, ListChecks, Article, ShieldCheck, Diamond, ChatCircleText } from "@phosphor-icons/react";
import { Stagger, StaggerItem } from "@/components/motion/Reveal";
import { Reveal } from "@/components/motion/Reveal";
import { FEATURES } from "@/content";

const ICONS: Icon[] = [ListChecks, Article, ShieldCheck, Diamond, ChatCircleText];

const SPANS = [
  "sm:col-span-2 lg:col-span-4",
  "lg:col-span-2",
  "lg:col-span-2",
  "lg:col-span-2",
  "lg:col-span-2",
];

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
      <Reveal>
        <h2 className="max-w-[20ch] text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
          Five things it does, all on the pull request.
        </h2>
        <p className="mt-5 max-w-[56ch] text-pretty text-lg leading-relaxed text-fg-muted">
          Reviews and descriptions run on their own when a pull request changes. The rest are a
          short comment away whenever you want them.
        </p>
      </Reveal>

      <Stagger className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6" gap={0.07}>
        {FEATURES.map((feature, i) => {
          const Glyph = ICONS[i];
          const featured = i === 0;
          return (
            <StaggerItem key={feature.title} className={SPANS[i]}>
              <article className="group relative flex h-full flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface/60 p-7 transition-colors duration-300 hover:border-border-hi">
                {featured ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-accent/10 blur-3xl"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-grid-faint opacity-40 [mask-image:radial-gradient(120%_80%_at_100%_0%,black,transparent)]"
                  />
                )}

                <div className="relative flex items-center justify-between">
                  <span className="flex size-11 items-center justify-center rounded-xl border border-border-hi bg-bg-soft text-accent">
                    <Glyph size={22} weight="regular" />
                  </span>
                  <code className="rounded-full border border-border-hi bg-bg-soft px-3 py-1 font-mono text-xs text-fg-dim">
                    {feature.command}
                  </code>
                </div>

                <h3 className="relative mt-6 text-xl font-medium tracking-tight text-fg">
                  {feature.title}
                </h3>
                <p className="relative mt-3 max-w-[48ch] leading-relaxed text-fg-muted">
                  {feature.body}
                </p>
              </article>
            </StaggerItem>
          );
        })}
      </Stagger>
    </section>
  );
}
