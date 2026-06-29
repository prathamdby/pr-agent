const plans = [
  {
    name: "Good",
    title: "Read the cost",
    price: "$0 from PR Agent",
    detail: "No card. No email. No per-seat fee from this MIT-licensed software.",
  },
  {
    name: "Better",
    title: "Run it for your team",
    price: "$0 software plus your vendors",
    detail:
      "Pay your hosting, Postgres, and LLM token bills. Add 50 developers and PR Agent stays at $0.",
  },
  {
    name: "Best",
    title: "Own the review stack",
    price: "$0 software plus your security process",
    detail:
      "Fork it, audit it, pin your model provider, and keep review traffic inside your network.",
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
        <p className="text-sm text-neutral-600 mb-4">
          Cost first, config second. Know what you pay before you enter GitHub credentials or model
          API keys.
        </p>

        <div className="grid gap-3">
          {plans.map((plan) => (
            <article key={plan.name} className="rounded-md border border-neutral-200 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-600">
                {plan.name}
              </p>
              <h3 className="mt-1 text-sm font-medium text-neutral-900">{plan.title}</h3>
              <p className="mt-1 text-sm text-neutral-800">{plan.price}</p>
              <p className="mt-2 text-sm text-neutral-600">{plan.detail}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
