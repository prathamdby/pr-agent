import { ALTERNATIVE_ROWS } from "@/lib/seo";

export function Alternatives() {
  return (
    <section
      id="alternatives"
      aria-labelledby="alternatives-heading"
      className="border-t border-gray-alpha-200 bg-background-100 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="alternatives-heading" className="text-heading-24 text-primary sm:text-heading-32">
          Self-Hosted Alternative to Hosted AI Reviewers
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          Teams evaluating CodeRabbit, Greptile, Cursor Bugbot, or Macroscope often need a GitHub
          pull request reviewer that runs on their own infrastructure. PR Agent is built for that.
        </p>

        <div className="mt-10 overflow-x-auto rounded-md border border-gray-alpha-200 shadow-card">
          <table className="w-full text-left text-copy-14">
            <thead>
              <tr className="border-b border-gray-alpha-200 bg-background-200">
                <th
                  scope="col"
                  className="py-3 pl-4 pr-3 text-label-14 font-medium text-secondary sm:pl-6"
                >
                  Tool
                </th>
                <th scope="col" className="py-3 pr-3 text-label-14 font-medium text-secondary">
                  Deployment
                </th>
                <th
                  scope="col"
                  className="py-3 pr-4 text-label-14 font-medium text-secondary sm:pr-6"
                >
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="text-secondary">
              {ALTERNATIVE_ROWS.map((row, index) => (
                <tr
                  key={row.name}
                  className={`align-top ${
                    index < ALTERNATIVE_ROWS.length - 1 ? "border-b border-gray-alpha-100" : ""
                  }`}
                >
                  <th scope="row" className="py-4 pl-4 pr-3 text-heading-14 text-primary sm:pl-6">
                    {row.name}
                  </th>
                  <td className="py-4 pr-3">{row.deployment}</td>
                  <td className="py-4 pr-4 sm:pr-6">{row.differentiator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
