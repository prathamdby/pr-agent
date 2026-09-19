import { Section } from "@/components/ui/section";
import { PRICING_PLANS } from "@/lib/content";

/** The price is the headline. Three plain columns under it, separated by hairlines, no cards. */
export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-heading" tone="surface">
      <div className="text-center">
        <p
          aria-hidden="true"
          className="tabular font-display text-[length:var(--text-price)] font-semibold leading-none tracking-[-0.06em] text-fg"
        >
          $0
        </p>
        <h2
          id="pricing-heading"
          className="mt-2 text-3xl font-semibold leading-[1.1] text-fg md:text-5xl"
        >
          No per-seat fee, ever
        </h2>
        <p className="mx-auto mt-4 max-w-[46ch] text-base leading-relaxed text-fg-muted md:text-lg">
          Know the cost before you connect GitHub or add an AI provider.
        </p>
      </div>

      <dl className="mx-auto mt-20 grid max-w-[64rem] divide-y divide-line border-y border-line md:grid-cols-3 md:divide-x md:divide-y-0">
        {PRICING_PLANS.map((plan) => (
          <div key={plan.title} className="px-2 py-8 md:px-8 md:py-4">
            <dt className="text-xl font-semibold text-fg">{plan.title}</dt>
            <p className="mt-1 font-mono text-[13px] text-blue">{plan.price}</p>
            <dd className="mt-4 text-base leading-relaxed text-fg-muted">{plan.detail}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
