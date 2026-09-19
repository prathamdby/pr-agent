import { Reveal, RevealItem } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/section";
import { FEATURES } from "@/lib/content";

/** The review path as a vertical rail. Headline stays pinned beside the steps on wide screens. */
export function HowItWorks() {
  return (
    <Section id="how-it-works" labelledBy="how-it-works-heading">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading
            id="how-it-works-heading"
            lede="One deploy. After that, every pull request follows the same path inside GitHub. No extra dashboard, no per-seat bill."
          >
            How a pull request gets its first pass
          </SectionHeading>
        </div>

        <Reveal as="ol" className="relative border-l border-line-strong">
          {FEATURES.map((feature, index) => (
            <RevealItem
              key={feature.title}
              as="li"
              className="relative pb-12 pl-8 last:pb-0 sm:pl-10"
            >
              <span
                aria-hidden="true"
                className="tabular absolute -left-[15px] top-0.5 grid size-[30px] place-items-center rounded-full bg-canvas font-mono text-[12px] font-semibold text-fg shadow-border"
              >
                {index + 1}
              </span>
              <h3 className="text-xl font-semibold leading-snug text-fg">{feature.title}</h3>
              <p className="mt-2 max-w-[60ch] text-base leading-relaxed text-fg-muted">
                {feature.detail}
              </p>
              <p className="mt-3 font-mono text-[13px] text-accent-ink">{feature.cue}</p>
            </RevealItem>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
