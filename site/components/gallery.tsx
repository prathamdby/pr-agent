import { AskReplyMock } from "@/components/github-output/ask-reply";
import { DescriptionBlockMock } from "@/components/github-output/description-block";
import { ReviewSummaryMock, type ReviewLens } from "@/components/github-output/review-summary";
import { Section } from "@/components/section";

type OutputExample = {
  readonly command: string;
  readonly label: string;
  readonly detail: string;
  readonly lens?: ReviewLens;
  readonly kind: "review" | "describe" | "ask";
};

const EXAMPLES: readonly OutputExample[] = [
  {
    command: "/review",
    label: "Review summary",
    detail: "PR conversation comment under ## PR Agent Review.",
    kind: "review",
    lens: "review",
  },
  {
    command: "/describe",
    label: "Description block",
    detail: "Merged into the PR body under ## PR Agent Description.",
    kind: "describe",
  },
  {
    command: "/ask",
    label: "Ask reply",
    detail: "Question and answer on the PR conversation.",
    kind: "ask",
  },
  {
    command: "/review-security",
    label: "Security review",
    detail: "Same summary shape under ## PR Agent Security Review.",
    kind: "review",
    lens: "review-security",
  },
  {
    command: "/review-quality",
    label: "Quality review",
    detail: "Same summary shape under ## PR Agent Quality Review.",
    kind: "review",
    lens: "review-quality",
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
    default: {
      const _exhaustive: never = example.kind;
      return _exhaustive;
    }
  }
}

/**
 * Desktop/tablet zig-zag moves the WHOLE block (caption + mock), not a
 * caption|mock split that leaves a dead column beside a tall card.
 */
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
          Built from the same summary, description, and ask formats the worker publishes to GitHub.
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
