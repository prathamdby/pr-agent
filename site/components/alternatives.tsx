import { ALTERNATIVE_ROWS } from "@/lib/seo";

export function Alternatives() {
  return (
    <section id="alternatives" aria-labelledby="alternatives-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="alternatives-heading" className="section-title mb-3 text-foreground-primary">
            Self-hosted alternative to hosted AI reviewers
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-xl mx-auto">
            Teams evaluating CodeRabbit, Greptile, Cursor Bugbot, or Macroscope often need a GitHub
            pull request reviewer that runs on their own infrastructure. PR Agent is built for that.
          </p>

          <div
            className="overflow-hidden rounded-[10px] border border-border-line"
            style={{ boxShadow: "var(--shadow-drop-sm)" }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="border-b border-border-secondary bg-background-secondary text-foreground-tertiary">
                    <th scope="col" className="py-3.5 px-4 font-medium">
                      Tool
                    </th>
                    <th scope="col" className="py-3.5 px-4 font-medium">
                      Deployment
                    </th>
                    <th scope="col" className="py-3.5 px-4 font-medium">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ALTERNATIVE_ROWS.map((row, i) => (
                    <tr
                      key={row.name}
                      className={`align-top transition-colors duration-200 hover:bg-background-tertiary ${
                        i < ALTERNATIVE_ROWS.length - 1 ? "border-b border-border-line" : ""
                      } ${row.name === "PR Agent" ? "bg-brand-8" : ""}`}
                      style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
                    >
                      <th scope="row" className="py-3.5 px-4 font-medium text-foreground-primary">
                        {row.name}
                      </th>
                      <td className="py-3.5 px-4 text-foreground-secondary">{row.deployment}</td>
                      <td className="py-3.5 px-4 text-foreground-secondary">
                        {row.differentiator}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
