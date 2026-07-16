import { AskReplyMock } from "@/components/github-output/ask-reply";
import { DescriptionBlockMock } from "@/components/github-output/description-block";
import { ReviewSummaryMock, type ReviewLens } from "@/components/github-output/review-summary";

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

export function Gallery() {
  return (
    <section
      id="examples"
      aria-labelledby="examples-heading"
      className="px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-xl">
          <h2
            id="examples-heading"
            className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
          >
            What lands on the pull request
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-mute">
            Built from the same summary, description, and ask formats the worker publishes to
            GitHub.
          </p>
        </div>

        <ul className="mt-14 space-y-14 lg:space-y-20">
          {EXAMPLES.map((example, index) => {
            const flip = index % 2 === 1;
            return (
              <li
                key={example.command}
                className="grid min-w-0 gap-5 lg:grid-cols-2 lg:items-center lg:gap-12"
              >
                <div className={`min-w-0 ${flip ? "lg:order-2" : ""}`}>
                  <p className="font-mono text-sm text-bolt">{example.command}</p>
                  <h3 className="mt-2 font-display text-2xl text-ink">{example.label}</h3>
                  <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-mute">
                    {example.detail}
                  </p>
                </div>
                <div
                  className={`min-w-0 w-full max-w-md ${
                    flip ? "lg:order-1 lg:justify-self-start" : "lg:justify-self-end"
                  }`}
                >
                  <ExampleBody example={example} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
