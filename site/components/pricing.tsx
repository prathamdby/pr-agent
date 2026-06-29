const plans = [
  {
    title: "Software is free",
    price: "$0 from PR Agent",
    detail: "No credit card. No per-seat fee. Open source under MIT.",
  },
  {
    title: "You pay your own vendors",
    price: "Hosting and AI usage only",
    detail:
      "Cover your server, database, and model bills. Add more developers without raising your PR Agent bill.",
  },
  {
    title: "You own the full stack",
    price: "Your security rules apply",
    detail:
      "Run it inside your network, choose your AI provider, and keep review traffic under your policies.",
  },
];

export function Pricing() {
  return (
    <section
      id="pricing"
      aria-labelledby="pricing-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="pricing-heading" className="text-xl mb-2">
          No per-seat fee, ever
        </h2>
        <p className="text-sm text-neutral-500 mb-4">
          Know the cost before you connect GitHub or add an AI provider.
        </p>

        <ul className="space-y-4">
          {plans.map((plan) => (
            <li key={plan.title} className="text-sm">
              <h3 className="font-medium text-neutral-800">{plan.title}</h3>
              <p className="text-neutral-500">{plan.price}</p>
              <p className="text-neutral-600 mt-0.5">{plan.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
