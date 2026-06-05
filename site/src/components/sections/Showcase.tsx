import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Reveal } from "@/components/motion/Reveal";
import { Frame } from "@/components/Frame";

type Shot = {
  id: string;
  tab: string;
  label: string;
  src: string;
  alt: string;
};

const SHOTS: Shot[] = [
  {
    id: "review",
    tab: "Review",
    label: "pull/482  ·  PR Agent Review",
    src: "/shots/review.png",
    alt: "A general review summary with inline findings on a pull request",
  },
  {
    id: "describe",
    tab: "Description",
    label: "pull/482  ·  PR Agent Description",
    src: "/shots/describe.png",
    alt: "A generated pull request description merged into the PR body",
  },
  {
    id: "security",
    tab: "Security",
    label: "pull/482  ·  PR Agent Security Review",
    src: "/shots/review-security.png",
    alt: "A focused security review summary on a pull request",
  },
  {
    id: "quality",
    tab: "Quality",
    label: "pull/482  ·  PR Agent Quality Review",
    src: "/shots/review-quality.png",
    alt: "A code quality review summary on a pull request",
  },
  {
    id: "ask",
    tab: "Ask",
    label: "pull/482  ·  answer on a diff line",
    src: "/shots/ask.png",
    alt: "An answer to a question posted on a specific line of the diff",
  },
];

export function Showcase() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const shot = SHOTS[active];

  return (
    <section className="border-t border-border bg-bg-soft/40">
      <div className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
        <Reveal>
          <h2 className="max-w-[20ch] text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
            See exactly what your team would see.
          </h2>
          <p className="mt-5 max-w-[56ch] text-pretty text-lg leading-relaxed text-fg-muted">
            No new dashboard to learn. Every result is a normal comment on the pull request, posted
            by your own GitHub App.
          </p>
        </Reveal>

        <Reveal delay={0.06}>
          <div
            role="tablist"
            aria-label="PR Agent output examples"
            className="mt-10 flex flex-wrap gap-1 rounded-full border border-border bg-surface/60 p-1.5"
          >
            {SHOTS.map((item, i) => {
              const selected = i === active;
              return (
                <button
                  key={item.id}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  onClick={() => setActive(i)}
                  className="relative rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200"
                >
                  {selected && (
                    <motion.span
                      layoutId="showcase-pill"
                      className="absolute inset-0 rounded-full bg-accent"
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    />
                  )}
                  <span
                    className={
                      selected
                        ? "relative text-accent-ink"
                        : "relative text-fg-muted hover:text-fg"
                    }
                  >
                    {item.tab}
                  </span>
                </button>
              );
            })}
          </div>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="relative mt-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={shot.id}
                initial={{ opacity: 0, y: reduce ? 0 : 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduce ? 0 : -10 }}
                transition={{ duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}
              >
                <Frame label={shot.label} src={shot.src} alt={shot.alt} />
              </motion.div>
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
