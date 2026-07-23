import { AskReplyMock } from "@/components/github-output/ask-reply";
import { DescriptionBlockMock } from "@/components/github-output/description-block";
import { ReviewSummaryMock, type ReviewLens } from "@/components/github-output/review-summary";
import { TriageReportMock } from "@/components/github-output/triage-report";
import { Section } from "@/components/section";

type OutputExample = {
  readonly command: string;
  readonly label: string;
  readonly detail: string;
  readonly lens?: ReviewLens;
  readonly kind: "review" | "describe" | "ask" | "triage";
};

const EXAMPLES: readonly OutputExample[] = [
  {
    command: "/review",
    label: "Review summary",
    detail: "A summary comment on the pull request conversation.",
    kind: "review",
    lens: "review",
  },
  {
    command: "/describe",
    label: "Description block",
    detail: "A readable summary merged into the pull request body.",
    kind: "describe",
  },
  {
    command: "/ask",
    label: "Ask reply",
    detail: "A question and answer right on the pull request.",
    kind: "ask",
  },
  {
    command: "/triage",
    label: "Triage report",
    detail: "Verdicts on earlier findings, with fixes pushed when they still apply.",
    kind: "triage",
  },
];

function ExampleBody({ example }: { readonly example: OutputExample }) {
  switch (example.kind) {
    case "review":
      return <ReviewSummaryMock lens={example.lens ?? "review"} />;
    case "describe":
      return <DescriptionBlockMock />;
    case "ask":
      return <AskReplyMock />;
    case "triage":
      return <TriageReportMock />;
    default: {
      const _exhaustive: never = example.kind;
      return _exhaustive;
    }
  }
}

export function Gallery() {
  return (
    <Section id="examples" labelledBy="examples-heading">
      <div className="max-w-2xl">
        <h2
          id="examples-heading"
          className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          What lands on the pull request
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-mute md:text-base">
          Same summary, description, ask, and triage formats PR Agent posts on a real pull request.
        </p>
      </div>

      <ul className="mt-12 space-y-12 md:mt-16 md:space-y-16">
        {EXAMPLES.map((example, index) => {
          const flip = index % 2 === 1;
          return (
            <li
              key={example.command}
              className={`flex min-w-0 ${flip ? "md:justify-end" : "md:justify-start"}`}
            >
              <div className="w-full min-w-0 md:max-w-[min(100%,36rem)]">
                <p className="font-mono text-sm text-bolt">{example.command}</p>
                <h3 className="mt-2 font-display text-xl text-ink sm:text-2xl">{example.label}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-mute">{example.detail}</p>
                <div className="mt-5 min-w-0">
                  <ExampleBody example={example} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
