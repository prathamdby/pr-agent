import { ALTERNATIVE_ROWS } from "@/lib/seo";

export function Alternatives() {
  return (
    <section
      id="alternatives"
      aria-labelledby="alternatives-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="alternatives-heading" className="section-title mb-4">
            Self-hosted alternative to hosted AI reviewers
          </h2>
          <p className="text-center text-foreground-secondary text-lg mb-10 max-w-2xl mx-auto">
            Teams evaluating CodeRabbit, Greptile, Cursor Bugbot, or Macroscope often need a
            GitHub pull request reviewer that runs on their own infrastructure. PR Agent is
            built for that.
          </p>
        </div>

        <div className="col-span-4 md:col-span-12 lg:col-span-24 overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="border-b border-border-line text-foreground-muted">
                <th scope="col" className="py-3 pr-4 font-medium">
                  Tool
                </th>
                <th scope="col" className="py-3 pr-4 font-medium">
                  Deployment
                </th>
                <th scope="col" className="py-3 font-medium">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="text-foreground-secondary">
              {ALTERNATIVE_ROWS.map((row) => (
                <tr
                  key={row.name}
                  className="border-b border-border-line align-top hover:bg-background-secondary transition-colors duration-200"
                >
                  <th
                    scope="row"
                    className={`py-3.5 pr-4 font-semibold ${
                      row.name === "PR Agent"
                        ? "text-brand-base"
                        : "text-foreground-primary"
                    }`}
                  >
                    {row.name === "PR Agent" ? (
                      <span className="flex items-center gap-2">
                        {row.name}
                        <span className="text-[10px] font-medium uppercase tracking-wider text-brand-base bg-brand-10 px-2 py-0.5 rounded-full">
                          Recommended
                        </span>
                      </span>
                    ) : (
                      row.name
                    )}
                  </th>
                  <td className="py-3.5 pr-4">{row.deployment}</td>
                  <td className="py-3.5">{row.differentiator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
