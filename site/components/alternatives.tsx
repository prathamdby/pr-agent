import { ALTERNATIVE_ROWS } from "@/lib/content";

export function Alternatives() {
  return (
    <section
      id="alternatives"
      aria-labelledby="alternatives-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="alternatives-heading" className="text-xl mb-2">
          Pick PR Agent when hosted review is the problem
        </h2>
        <p className="text-sm text-neutral-500 mb-4">
          CodeRabbit, Greptile, Cursor Bugbot, and Macroscope sell a hosted review layer. PR Agent
          is for teams that want the reviewer, the AI keys, and the review data in their own
          account.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Tool
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Deployment
                </th>
                <th scope="col" className="py-2 font-medium">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="text-neutral-600">
              {ALTERNATIVE_ROWS.map((row) => (
                <tr key={row.name} className="border-b border-neutral-100 align-top">
                  <th scope="row" className="py-3 pr-3 font-medium text-neutral-800">
                    {row.name}
                  </th>
                  <td className="py-3 pr-3">{row.deployment}</td>
                  <td className="py-3">{row.differentiator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
