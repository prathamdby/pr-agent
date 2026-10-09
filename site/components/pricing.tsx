import { Section, SectionTitle } from "@/components/section";
import { PRICING_PLANS } from "@/lib/content";

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-heading">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <div className="max-w-2xl">
          <SectionTitle id="pricing-heading" eyebrow="Pricing">
            No per-seat fee, ever
          </SectionTitle>
          <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-secondary sm:text-lead">
            Know the cost before you connect GitHub or add an AI provider.
          </p>
        </div>
        <p className="tabular text-[clamp(4.5rem,10vw,8rem)] leading-none font-medium tracking-[-0.05em] text-text lg:text-right">
          $0
        </p>
      </div>

      <ul className="mt-10 grid gap-10 border-t border-line pt-10 sm:mt-12 md:grid-cols-3 md:gap-8">
        {PRICING_PLANS.map((plan) => (
          <li key={plan.title}>
            <p className="text-label font-medium text-accent-text">{plan.price}</p>
            <h3 className="mt-2 text-lead leading-snug font-medium text-text">{plan.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">{plan.detail}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
