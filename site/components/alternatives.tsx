import { ALTERNATIVE_ROWS } from "@/lib/seo";

export function Alternatives() {
  return (
    <section
      id="alternatives"
      aria-labelledby="alternatives-heading"
      className="section section-border"
    >
      <div className="container-geist">
        <div className="mx-auto max-w-2xl text-center mb-10">
          <h2 id="alternatives-heading" className="heading-32 mb-3">
            Self-Hosted Alternative to SaaS Reviewers
          </h2>
          <p className="copy-16 text-gray-900">
            Teams evaluating CodeRabbit, Greptile, Cursor Bugbot, or Macroscope often need a GitHub
            pull-request reviewer that runs on their own infrastructure. PR Agent is built for that.
          </p>
        </div>

        <div className="mx-auto max-w-4xl overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-alpha-400">
                <th
                  scope="col"
                  className="label-12 text-gray-700 pb-3 pr-4 font-medium uppercase tracking-wider"
                >
                  Tool
                </th>
                <th
                  scope="col"
                  className="label-12 text-gray-700 pb-3 pr-4 font-medium uppercase tracking-wider"
                >
                  Deployment
                </th>
                <th
                  scope="col"
                  className="label-12 text-gray-700 pb-3 font-medium uppercase tracking-wider"
                >
                  Notes
                </th>
              </tr>
            </thead>
            <tbody>
              {ALTERNATIVE_ROWS.map((row, index) => (
                <tr
                  key={row.name}
                  className={`border-b border-gray-alpha-400 ${index === 0 ? "font-medium" : ""}`}
                >
                  <th scope="row" className="heading-14 py-4 pr-4 text-left">
                    {row.name}
                  </th>
                  <td className="copy-14 text-gray-900 py-4 pr-4">{row.deployment}</td>
                  <td className="copy-14 text-gray-700 py-4">{row.differentiator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
