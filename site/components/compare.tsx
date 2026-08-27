import { Section } from "@/components/section";
import { ALTERNATIVE_ROWS, PRICING_PLANS, PROVIDERS } from "@/lib/content";

export function Compare() {
  const [provider] = PROVIDERS;

  return (
    <Section id="pricing" labelledBy="pricing-heading" raised>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:gap-10">
        <div className="min-w-0">
          <p className="font-display text-[clamp(2.5rem,6vw,3.75rem)] leading-none tracking-[-0.03em] text-ink">
            $0
          </p>
          <h2
            id="pricing-heading"
            className="mt-2 font-display text-[clamp(1.35rem,2.2vw,1.75rem)] leading-tight text-ink-soft"
          >
            No per-seat fee, ever
          </h2>
          <p className="mt-2 text-sm leading-snug text-ink-mute">
            Know the cost before you connect GitHub or add an AI provider.
          </p>
        </div>

        <dl className="grid gap-5 sm:grid-cols-3 sm:gap-6">
          {PRICING_PLANS.map((plan) => (
            <div key={plan.title} className="min-w-0">
              <dt className="text-sm font-medium text-ink">{plan.title}</dt>
              <dd className="mt-1.5">
                <p className="font-mono text-[0.8rem] text-sky">{plan.price}</p>
                <p className="mt-1.5 text-sm leading-snug text-ink-mute">{plan.detail}</p>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div id="alternatives" className="mt-8">
        <h3
          id="alternatives-heading"
          className="font-display text-[clamp(1.35rem,2.2vw,1.75rem)] leading-tight text-ink"
        >
          Pick PR Agent when hosted review is the problem
        </h3>
        <p className="mt-2 max-w-2xl text-sm leading-snug text-ink-mute">
          CodeRabbit, Greptile, Cursor Bugbot, and Macroscope sell hosted review. PR Agent is for
          teams that want the reviewer, the AI keys, and the review data in their own account.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead>
              <tr className="text-ink-faint">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Tool
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Deployment
                </th>
                <th scope="col" className="py-2 font-medium">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="text-ink-mute">
              {ALTERNATIVE_ROWS.map((row) => {
                const isSelf = row.name === "PR Agent";
                return (
                  <tr key={row.name} className="align-top">
                    <th
                      scope="row"
                      className={`py-2.5 pr-4 font-medium ${isSelf ? "text-bolt" : "text-ink"}`}
                    >
                      {row.name}
                    </th>
                    <td className="py-2.5 pr-4">{row.deployment}</td>
                    <td className="py-2.5">{row.differentiator}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {provider ? (
        <p id="providers" className="mt-6 max-w-2xl text-sm leading-snug text-ink-mute">
          <span className="text-ink">{provider.name}.</span> {provider.detail} Switch from GPT to
          Claude to DeepSeek by changing a setting. See{" "}
          <a
            href="#usage"
            className="text-ink-soft underline decoration-edge-strong hover:text-ink"
          >
            Docker Compose setup
          </a>
          .
        </p>
      ) : null}
    </Section>
  );
}
