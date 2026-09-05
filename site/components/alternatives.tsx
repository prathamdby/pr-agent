import { Section } from "@/components/section";
import { ALTERNATIVE_ROWS } from "@/lib/content";

export function Alternatives() {
  return (
    <Section id="alternatives" labelledBy="alternatives-heading" raised>
      <h2
        id="alternatives-heading"
        className="max-w-[22ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
      >
        Pick PR Agent when hosted review is the problem
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-mute">
        CodeRabbit, Greptile, Cursor Bugbot, and Macroscope sell hosted review. PR Agent is for
        teams that want to run the reviewer, hold the AI keys, and choose the provider that
        receives review context.
      </p>

      <div className="mt-12 overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-edge-strong text-ink-faint">
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
          <tbody className="text-ink-mute">
            {ALTERNATIVE_ROWS.map((row) => {
              const isSelf = row.name === "PR Agent";
              return (
                <tr key={row.name} className="border-b border-edge align-top">
                  <th
                    scope="row"
                    className={`py-4 pr-4 font-medium ${isSelf ? "text-bolt" : "text-ink"}`}
                  >
                    {row.name}
                  </th>
                  <td className="py-4 pr-4">{row.deployment}</td>
                  <td className="py-4">{row.differentiator}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
