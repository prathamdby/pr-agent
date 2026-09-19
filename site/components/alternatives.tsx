import { CheckIcon, MinusIcon, XIcon } from "@phosphor-icons/react";
import { BrandMark } from "@/components/ui/brand-mark";
import { Section, SectionHeading } from "@/components/ui/section";

type Score = "yes" | "partial" | "no";

type Criterion = {
  readonly label: string;
  readonly scores: readonly [Score, Score, Score, Score, Score];
};

const TOOLS = ["PR Agent", "CodeRabbit", "Greptile", "Cursor Bugbot", "Macroscope"] as const;
const MARKS = ["", "coderabbit", "greptile", "cursor", "macroscope"] as const;

/*
  Scorecard. Column one is PR Agent. Values reflect each vendor's public positioning at the time
  of writing: self-hosting, licence, pricing model, and where model keys live.
*/
const CRITERIA: readonly Criterion[] = [
  { label: "Runs on your servers", scores: ["yes", "partial", "partial", "no", "no"] },
  { label: "Open source, MIT", scores: ["yes", "no", "no", "no", "no"] },
  { label: "No per-seat fee", scores: ["yes", "no", "no", "no", "no"] },
  { label: "Bring your own model keys", scores: ["yes", "no", "no", "no", "no"] },
  { label: "Choose the model provider", scores: ["yes", "no", "no", "no", "no"] },
  { label: "Review data stays in your account", scores: ["yes", "partial", "partial", "no", "no"] },
  { label: "Reviews GitHub pull requests", scores: ["yes", "yes", "yes", "yes", "yes"] },
  { label: "Whole-repository index", scores: ["partial", "yes", "yes", "partial", "yes"] },
  {
    label: "PR description, ask, and fix commands",
    scores: ["yes", "yes", "partial", "no", "partial"],
  },
];

function ToolMark({
  index,
  tool,
  stacked = false,
}: {
  readonly index: number;
  readonly tool: string;
  readonly stacked?: boolean;
}) {
  return (
    <span
      className={`inline-flex min-w-0 ${stacked ? "flex-col items-center gap-1.5" : "items-center gap-2"}`}
    >
      {index === 0 ? (
        <img src="/logo.png" alt="" width={20} height={20} className="size-5 rounded-[5px]" />
      ) : (
        <BrandMark slug={MARKS[index] ?? ""} />
      )}
      <span className={`min-w-0 ${stacked ? "text-center" : ""}`}>{tool}</span>
    </span>
  );
}

function Cell({ score }: { readonly score: Score }) {
  if (score === "yes") {
    return (
      <span className="inline-flex items-center justify-center gap-1.5 text-fg">
        <CheckIcon className="size-4 text-blue" />
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (score === "partial") {
    return (
      <span className="inline-flex items-center justify-center gap-1.5 text-fg-muted">
        <MinusIcon className="size-4" />
        <span className="text-[12px]">Partial</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center text-fg-subtle">
      <XIcon className="size-4" />
      <span className="sr-only">No</span>
    </span>
  );
}

export function Alternatives() {
  return (
    <Section id="alternatives" labelledBy="alternatives-heading" tone="surface">
      <SectionHeading
        id="alternatives-heading"
        lede="CodeRabbit, Greptile, Cursor Bugbot, and Macroscope sell hosted review. PR Agent is for teams that want the reviewer, the AI keys, and the review data in their own account."
      >
        Pick PR Agent when hosted review is the problem
      </SectionHeading>

      <ul className="mt-10 space-y-4 xl:hidden">
        {CRITERIA.map((row) => (
          <li key={row.label} className="card rounded-panel p-4 sm:p-5">
            <p className="font-semibold text-fg">{row.label}</p>
            <ul className="mt-3 divide-y divide-line">
              {TOOLS.map((tool, index) => (
                <li
                  key={tool}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className={`min-w-0 ${index === 0 ? "text-fg" : "text-fg-muted"}`}>
                    <ToolMark index={index} tool={tool} />
                  </span>
                  <Cell score={row.scores[index] ?? "no"} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div className="mt-12 hidden min-w-0 xl:block">
        <table className="scorecard w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line-strong">
              <th scope="col" className="w-[26%] py-3 pr-4 text-[12px] font-medium text-fg-subtle">
                Criteria
              </th>
              {TOOLS.map((tool, index) => (
                <th
                  key={tool}
                  scope="col"
                  className={`px-2 py-3 text-center text-[15px] font-semibold ${index === 0 ? "text-fg" : "text-fg-muted"}`}
                >
                  <ToolMark index={index} tool={tool} stacked />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CRITERIA.map((row) => (
              <tr key={row.label} className="border-b border-line">
                <th scope="row" className="py-3.5 pr-4 font-medium text-fg">
                  {row.label}
                </th>
                {row.scores.map((score, index) => (
                  <td
                    key={TOOLS[index]}
                    className="px-2 py-3.5 text-center"
                    data-self={index === 0 ? "" : undefined}
                  >
                    <Cell score={score} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
