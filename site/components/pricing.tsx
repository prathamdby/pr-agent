import { PRICING_PLANS } from "@/lib/content";

export function Pricing() {
  return (
    <section
      id="pricing"
      aria-labelledby="pricing-heading"
      className="bg-navy-raised px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <p className="font-display text-[clamp(3.5rem,10vw,6.5rem)] leading-none tracking-[-0.03em] text-ink">
          $0
        </p>
        <h2
          id="pricing-heading"
          className="mt-4 max-w-[20ch] font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.15] text-ink-soft"
        >
          No per-seat fee, ever
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-mute">
          Know the cost before you connect GitHub or add an AI provider.
        </p>

        <dl className="mt-14 grid gap-8 border-t border-edge pt-10 md:grid-cols-3 md:gap-10">
          {PRICING_PLANS.map((plan) => (
            <div key={plan.title}>
              <dt className="text-base font-medium text-ink">{plan.title}</dt>
              <dd className="mt-2">
                <p className="font-mono text-sm text-sky">{plan.price}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-mute">{plan.detail}</p>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
