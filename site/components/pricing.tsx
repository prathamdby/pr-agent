import type { ComponentType } from "react";
import { Server, Shield, Wallet } from "@/components/icons";
import { Eyebrow, Section } from "@/components/section";
import { PRICING_PLANS } from "@/lib/content";

type IconComponent = ComponentType<{ readonly className?: string }>;

const PLAN_ART: readonly { readonly icon: IconComponent; readonly texture: string }[] = [
  { icon: Wallet, texture: "wash-grid" },
  { icon: Server, texture: "wash-clouds" },
  { icon: Shield, texture: "wash-grid" },
];

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-heading">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <div className="max-w-2xl">
          <Eyebrow>Pricing</Eyebrow>
          <h2
            id="pricing-heading"
            className="mt-4 text-[clamp(1.875rem,3.4vw,2.625rem)] font-medium leading-[1.12] tracking-[-0.025em] text-text"
          >
            No per-seat fee, ever
          </h2>
          <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]">
            Know the cost before you connect GitHub or add an AI provider.
          </p>
        </div>
        <p className="tabular text-[clamp(4.5rem,10vw,8rem)] leading-none font-medium tracking-[-0.05em] text-text lg:text-right">
          $0
        </p>
      </div>

      <ul className="mt-10 grid gap-6 sm:mt-12 md:grid-cols-3 md:gap-6">
        {PRICING_PLANS.map((plan, index) => {
          const art = PLAN_ART[index % PLAN_ART.length];
          const Icon = art.icon;
          const flipped = index % 2 === 1;
          return (
            <li
              key={plan.title}
              className="flex flex-col rounded-xl bg-surface-raised p-2 shadow-ring"
            >
              {/*
                Grey shell: the wash graphic is inset at the top and the copy sits in the shell's
                footer. The middle card flips, copy on top, so the cards alternate.
              */}
              <div
                className={`wash ${art.texture} flex aspect-[4/3] flex-col items-center justify-center gap-5 rounded-md shadow-soft`}
              >
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
                <h3 className="text-[17px] leading-snug font-medium text-text">{plan.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{plan.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
