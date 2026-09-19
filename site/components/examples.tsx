import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import {
  AskComment,
  DescribeComment,
  ReviewComment,
  TriageComment,
} from "@/components/gh/comments";
import { Section, SectionHeading } from "@/components/ui/section";

type Example = {
  readonly command: string;
  readonly title: string;
  readonly detail: string;
  readonly render: () => ReactNode;
};

const EXAMPLES: readonly Example[] = [
  {
    command: "/review",
    title: "Review summary",
    detail: "A summary comment in the conversation. Findings sit next to the changed lines.",
    render: () => <ReviewComment />,
  },
  {
    command: "/describe",
    title: "Description block",
    detail: "A readable summary merged into the pull request body, with a file walkthrough.",
    render: () => <DescribeComment />,
  },
  {
    command: "/ask",
    title: "Ask reply",
    detail: "A question and its answer, right in the thread where you asked it.",
    render: () => <AskComment />,
  },
  {
    command: "/triage",
    title: "Triage report",
    detail: "Verdicts on earlier findings, with fixes pushed when they still apply.",
    render: () => <TriageComment />,
  },
];

/** Each command's output, rendered in GitHub markup inside one fixed-height frame. */
export function Examples() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const baseId = useId();
  const current = EXAMPLES[active] ?? EXAMPLES[0];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const next = (active + delta + EXAMPLES.length) % EXAMPLES.length;
    setActive(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  return (
    <Section id="examples" labelledBy="examples-heading">
      <SectionHeading
        id="examples-heading"
        lede="Every command answers in the pull request, in plain GitHub markdown your team already reads."
      >
        What lands on the pull request
      </SectionHeading>

      <div className="card mt-12 grid overflow-hidden rounded-panel lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div
          role="tablist"
          aria-label="Example outputs"
          aria-orientation="vertical"
          className="flex gap-1 overflow-x-auto border-b border-line p-3 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r"
          onKeyDown={onKeyDown}
        >
          {EXAMPLES.map((example, index) => {
            const selected = index === active;
            return (
              <button
                key={example.command}
                type="button"
                role="tab"
                id={`${baseId}-tab-${index}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(index)}
                className={`press relative shrink-0 rounded-[12px] p-4 text-left transition-[color] duration-150 ease-out ${
                  selected ? "text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {selected ? (
                  <motion.span
                    layoutId={reduce ? undefined : `${baseId}-indicator`}
                    className="absolute inset-0 rounded-[12px] bg-well"
                    transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="relative block">
                  <code className="text-[13px] font-medium text-accent-ink">{example.command}</code>
                  <span className="mt-1 block text-base font-semibold">{example.title}</span>
                  <span className="mt-1 hidden text-sm leading-relaxed text-fg-muted lg:block">
                    {example.detail}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${active}`}
          className="h-[34rem] min-w-0 overflow-y-auto p-5 text-[13px] leading-[1.5] sm:p-8"
          style={{ background: "var(--gh-canvas)", color: "var(--gh-fg)" }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.command}
              initial={reduce ? false : { opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{
                opacity: 1,
                y: 0,
                filter: "blur(0px)",
                transition: { duration: 0.3, ease: [0.23, 1, 0.32, 1] },
              }}
              exit={
                reduce
                  ? undefined
                  : {
                      opacity: 0,
                      y: -12,
                      filter: "blur(4px)",
                      transition: { duration: 0.15, ease: "easeOut" },
                    }
              }
            >
              {current.render()}
              <p className="mt-4 text-sm text-fg-muted lg:hidden">{current.detail}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
