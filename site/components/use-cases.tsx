import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ButtonLink } from "@/components/button";
import { AskReplyMock } from "@/components/github-output/ask-reply";
import { DescriptionBlockMock } from "@/components/github-output/description-block";
import { ReviewSummaryMock } from "@/components/github-output/review-summary";
import { TriageReportMock } from "@/components/github-output/triage-report";
import { ArrowUpRight } from "@/components/icons";
import { Section, SectionHeading } from "@/components/section";
import { REPO_URL } from "@/lib/site";

type CaseKind = "review" | "describe" | "ask" | "triage";

type UseCase = {
  readonly kind: CaseKind;
  readonly command: string;
  readonly tab: string;
  readonly title: string;
  readonly description: string;
  readonly bullets: readonly string[];
};

const FEATURES_DOC_URL = `${REPO_URL}/blob/main/docs/features.md`;

const CASES: readonly UseCase[] = [
  {
    kind: "review",
    command: "/review",
    tab: "Review",
    title: "Findings on the lines that changed",
    description:
      "Four specialists read the branch and the diff for correctness, security, quality, and tests. One orchestrator decides what is worth posting.",
    bullets: [
      "Comments land next to the changed lines, with a summary in the conversation",
      "Runs when a pull request opens, or when you comment /review",
      "P0–P2 findings fail the PR Agent Review check. P3 does not",
      "Docs-only pull requests take a lighter path instead of a full run",
    ],
  },
  {
    kind: "describe",
    command: "/describe",
    tab: "Describe",
    title: "A readable summary in the pull request body",
    description:
      "Turn a blank description into a type, summary bullets, a changes diagram, and a file walkthrough.",
    bullets: [
      "Runs when a pull request opens, or when you comment /describe",
      "Sections: PR type, description, changes diagram, file walkthrough",
      "Optional title rewrite, controlled by FEATURE_TITLE_REWRITE",
      "Stop it from calling the model with FEATURE_DESCRIBE=off",
    ],
  },
  {
    kind: "ask",
    command: "/ask",
    tab: "Ask",
    title: "Answers in the same thread",
    description:
      "Ask about the code without leaving GitHub. Comment /ask followed by your question, or mention the App bot.",
    bullets: [
      "Comment /ask … on the pull request, or mention the App bot",
      "Replies land in the same thread as the question",
      "The prompt carries a read-only CI state block for the head",
      "Outbound redaction runs before anything is posted",
    ],
  },
  {
    kind: "triage",
    command: "/triage",
    tab: "Triage",
    title: "Revisit earlier findings and push the fixes",
    description:
      "Preview the would-be diff, then apply the approved set. Bare /triage still fixes without a preview.",
    bullets: [
      "/triage preview renders the diff. Nothing is pushed",
      "/triage all replays the previewed set for this head",
      "Every finding gets a verdict, from fixed to dismissed",
      "Dismissed findings come with policy suggestions for .pr-agent/*.mdc",
    ],
  },
];

function CaseMock({ kind }: { readonly kind: CaseKind }) {
  switch (kind) {
    case "review":
      return <ReviewSummaryMock frame="window" />;
    case "describe":
      return <DescriptionBlockMock />;
    case "ask":
      return <AskReplyMock />;
    case "triage":
      return <TriageReportMock />;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function UseCases() {
  const [active, setActive] = useState<CaseKind>("review");
  const baseId = useId();
  const tabs = useRef(new Map<CaseKind, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = CASES.findIndex((item) => item.kind === active);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % CASES.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + CASES.length) % CASES.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = CASES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = CASES[next];
    setActive(target.kind);
    tabs.current.get(target.kind)?.focus();
  };

  return (
    <Section id="examples" labelledBy="examples-heading">
      <SectionHeading
        id="examples-heading"
        eyebrow="Use cases"
        title="One App. Every pull request covered."
        description="The same summary, description, ask, and triage formats PR Agent posts on a real pull request. Pick a command to see what lands."
      />

      <div className="tabs-shell mt-10 sm:mt-12">
        <div
          role="tablist"
          aria-label="Output examples"
          onKeyDown={onKeyDown}
          className="grid grid-cols-2 gap-1 sm:grid-cols-4"
        >
          {CASES.map((item) => {
            const selected = item.kind === active;
            return (
              <button
                key={item.kind}
                type="button"
                role="tab"
                id={`${baseId}-tab-${item.kind}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${item.kind}`}
                tabIndex={selected ? 0 : -1}
                ref={(node) => {
                  if (node === null) {
                    tabs.current.delete(item.kind);
                  } else {
                    tabs.current.set(item.kind, node);
                  }
                }}
                onClick={() => setActive(item.kind)}
                className={
                  selected
                    ? "btn tabs-tab h-11 bg-surface text-[15px] text-text shadow-tab"
                    : "btn btn-ghost tabs-tab h-11 text-[15px] font-normal"
                }
              >
                <span>{item.tab}</span>
              </button>
            );
          })}
        </div>

        {CASES.map((item) => (
          <div
            key={item.kind}
            role="tabpanel"
            id={`${baseId}-panel-${item.kind}`}
            aria-labelledby={`${baseId}-tab-${item.kind}`}
            hidden={item.kind !== active}
            className="tabs-panel grid gap-1.5 lg:h-[39rem] lg:grid-cols-[minmax(0,9fr)_minmax(0,11fr)] lg:overflow-hidden"
          >
            <div className="flex flex-col p-5 motion-safe:animate-panel-in sm:p-8 lg:p-10">
              <code className="inline-flex w-fit rounded-xs bg-accent-soft px-2 py-1 font-mono text-xs font-medium text-accent-text">
                {item.command}
              </code>
              <h3 className="mt-4 text-2xl font-medium tracking-[-0.02em] text-text">
                {item.title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {item.description}
              </p>
              <ul className="mt-6 divide-y divide-line">
                {item.bullets.map((bullet) => (
                  <li
                    key={bullet}
                    className="flex items-start gap-3 py-3 text-[15px] leading-snug text-text"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-solid"
                    />
                    {bullet}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-8">
                <ButtonLink
                  href={FEATURES_DOC_URL}
                  external
                  variant="secondary"
                  trailingIcon={<ArrowUpRight className="size-4 text-text-tertiary" />}
                >
                  Read the feature docs
                </ButtonLink>
              </div>
            </div>

            <div className="wash wash-clouds tabs-media p-4 sm:p-6 lg:p-8">
              {/*
                Same height for every tab: long outputs scroll behind a bottom fade. At desktop widths
                the preview is taken out of flow, so its content can never stretch the row.
              */}
              <div className="h-[24rem] [mask-image:linear-gradient(to_bottom,black_78%,transparent_100%)] sm:h-[27rem] lg:absolute lg:inset-8 lg:h-auto">
                <div
                  role="region"
                  aria-label={`${item.tab} example output`}
                  tabIndex={0}
                  className="scrollbar-none h-full overflow-y-auto overscroll-contain rounded-md focus-visible:outline-offset-[-3px]"
                >
                  <CaseMock kind={item.kind} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
