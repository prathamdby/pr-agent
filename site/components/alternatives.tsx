import { BrandLogo } from "@/components/brand-logos";
import { Check, Minus, X } from "@/components/icons";
import { Section, SectionHeading } from "@/components/section";
import { ALTERNATIVE_ROWS, COMPARISON_CRITERIA, type ComparisonMark } from "@/lib/content";
import { PRODUCT_NAME } from "@/lib/seo";

const SELF = ALTERNATIVE_ROWS.find((row) => row.name === PRODUCT_NAME)?.id ?? "pr-agent";

/** Icon plus text for every state, so the mark never rests on colour alone. */
function Mark({ value }: { readonly value: ComparisonMark }) {
  switch (value) {
    case "yes":
      return (
        <span className="inline-flex size-6 items-center justify-center text-accent-text">
          <Check className="size-[18px]" />
          <span className="sr-only">Yes</span>
        </span>
      );
    case "partial":
      return (
        <span className="inline-flex h-6 items-center gap-1.5 text-xs text-text-secondary">
          <Minus className="size-3.5" />
          Partial
        </span>
      );
    case "no":
      return (
        <span className="inline-flex size-6 items-center justify-center text-text-tertiary">
          <X className="size-4" />
          <span className="sr-only">No</span>
        </span>
      );
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

function ComparisonTable() {
  return (
    <div className="hidden overflow-hidden rounded-lg bg-surface shadow-card md:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th
              scope="col"
              className="w-[26%] px-5 pt-5 pb-4 text-xs font-medium text-text-tertiary"
            >
              Criteria
            </th>
            {ALTERNATIVE_ROWS.map((tool) => (
              <th
                key={tool.id}
                scope="col"
                className={
                  tool.id === SELF
                    ? "bg-accent-soft/60 px-3 pt-5 pb-4 text-center"
                    : "px-3 pt-5 pb-4 text-center"
                }
              >
                <span className="inline-flex flex-col items-center gap-2.5 text-text">
                  <BrandLogo name={tool.id} className="size-6" />
                  <span className="text-[13px] font-medium">{tool.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {COMPARISON_CRITERIA.map((criterion) => (
            <tr key={criterion.label}>
              <th
                scope="row"
                className="px-5 py-3.5 text-[15px] leading-snug font-medium text-text"
              >
                {criterion.label}
              </th>
              {ALTERNATIVE_ROWS.map((tool) => (
                <td
                  key={tool.id}
                  className={
                    tool.id === SELF
                      ? "bg-accent-soft/60 px-3 py-3.5 text-center"
                      : "px-3 py-3.5 text-center"
                  }
                >
                  <Mark value={criterion.marks[tool.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One card per criterion so the comparison stays two columns wide on a phone. */
function ComparisonCards() {
  return (
    <ul className="space-y-4 md:hidden">
      {COMPARISON_CRITERIA.map((criterion) => (
        <li key={criterion.label} className="rounded-lg bg-surface px-5 pt-5 pb-2 shadow-card">
          <h3 className="text-[15px] leading-snug font-medium text-text">{criterion.label}</h3>
          <ul className="mt-2 divide-y divide-line">
            {ALTERNATIVE_ROWS.map((tool) => {
              const self = tool.id === SELF;
              return (
                <li key={tool.id} className="flex min-h-12 items-center justify-between gap-4 py-2">
                  <span
                    className={
                      self
                        ? "inline-flex items-center gap-2.5 text-[15px] font-medium text-text"
                        : "inline-flex items-center gap-2.5 text-[15px] text-text-secondary"
                    }
                  >
                    <BrandLogo name={tool.id} className="size-[18px] shrink-0" />
                    {tool.name}
                  </span>
                  <Mark value={criterion.marks[tool.id]} />
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function Alternatives() {
  return (
    <Section id="alternatives" labelledBy="alternatives-heading">
      <SectionHeading
        id="alternatives-heading"
        eyebrow="Compare"
        title="Pick PR Agent when hosted review is the problem"
        description="CodeRabbit, Greptile, Cursor Bugbot, and Macroscope sell hosted review. PR Agent is for teams that want the reviewer, the AI keys, and the review data in their own account."
      />
      <div className="mt-10 sm:mt-12">
        <ComparisonTable />
        <ComparisonCards />
      </div>
    </Section>
  );
}
