import type { ComponentType } from "react";
import { Server, Shield, Wallet } from "@/components/icons";
import { SectionTitle } from "@/components/section";
import { PRICING_PLANS } from "@/lib/content";

type IconComponent = ComponentType<{ readonly className?: string }>;

const PLAN_ICONS: readonly IconComponent[] = [Wallet, Server, Shield];

export function Pricing() {
  return (
    <section aria-labelledby="pricing-heading" className="sky-band py-20 sm:py-24 lg:py-30">
      <div id="pricing" className="container-x scroll-mt-5">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <SectionTitle
            id="pricing-heading"
            eyebrow="Pricing"
            figure={<p className="figure-sky tabular mt-7 mb-2">$0</p>}
          >
            No per-seat fee, ever
          </SectionTitle>
          <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-secondary sm:text-lead">
            Know the cost before you connect GitHub or add an AI provider.
          </p>
        </div>

        <ul className="mt-10 grid gap-6 sm:mt-12 md:grid-cols-3 md:gap-6">
          {PRICING_PLANS.map((plan, index) => {
            const Icon = PLAN_ICONS[index % PLAN_ICONS.length];
            const flipped = index % 2 === 1;
            return (
              <li key={plan.title} className="flex flex-col rounded-xl bg-surface p-2 shadow-card">
                <div className="wash wash-clouds flex aspect-[4/3] flex-col items-center justify-center gap-5 rounded-md shadow-soft">
                  <span
                    aria-hidden="true"
                    className="grid size-20 place-items-center rounded-md bg-surface text-accent-text shadow-card"
                  >
                    <Icon className="size-9" />
                  </span>
                  <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium whitespace-nowrap text-accent-text shadow-soft">
                    {plan.price}
                  </span>
                </div>
                <div className={`flex-1 px-3 ${flipped ? "order-first pt-3 pb-4" : "pt-4 pb-3"}`}>
                  <h3 className="text-lead leading-snug font-medium text-text">{plan.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                    {plan.detail}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
