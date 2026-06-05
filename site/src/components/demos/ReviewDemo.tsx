import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Circle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

type Phase = "reading" | "found";

const DIFF: { n: number; text: string; kind: "ctx" | "del" | "add"; focus?: boolean }[] = [
  { n: 40, text: "const items = await listChangedFiles(pr)", kind: "ctx" },
  { n: 41, text: "for (const file of items) {", kind: "del" },
  { n: 42, text: "for (const file of items.slice(0, MAX)) {", kind: "add", focus: true },
  { n: 43, text: "  await review(file)", kind: "ctx" },
  { n: 44, text: "}", kind: "ctx" },
];

const KIND_STYLE: Record<string, string> = {
  ctx: "text-fg-muted",
  del: "text-danger/80 bg-danger/5",
  add: "text-accent bg-accent/5",
};

/**
 * A real, animated rendering of a PR Agent review being produced: the diff is
 * scanned, then an inline finding lands with its severity. Not a screenshot.
 */
export function ReviewDemo() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(reduce ? "found" : "reading");

  useEffect(() => {
    if (reduce) return;
    let toFound: ReturnType<typeof setTimeout>;
    let loop: ReturnType<typeof setTimeout>;
    const run = () => {
      setPhase("reading");
      toFound = setTimeout(() => setPhase("found"), 2200);
      loop = setTimeout(run, 8200);
    };
    run();
    return () => {
      clearTimeout(toFound);
      clearTimeout(loop);
    };
  }, [reduce]);

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-line-hi bg-bg-soft shadow-[var(--shadow-lift)]">
      <div className="flex items-center gap-2.5 border-b border-line bg-surface/70 px-4 py-3">
        <span className="flex size-5 items-center justify-center rounded-md bg-accent/15">
          <Check size={12} weight="bold" className="text-accent" />
        </span>
        <span className="text-sm font-medium text-fg">PR Agent</span>
        <span className="mono-caption">reviewed pull/482</span>
        <div className="ml-auto">
          <AnimatePresence mode="wait" initial={false}>
            {phase === "reading" ? (
              <motion.span
                key="reading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 font-mono text-xs text-fg-dim"
              >
                <motion.span
                  className="size-1.5 rounded-full bg-accent"
                  animate={reduce ? {} : { opacity: [1, 0.25, 1] }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                />
                reading diff
              </motion.span>
            ) : (
              <motion.span
                key="done"
                initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-1.5 font-mono text-xs text-accent"
              >
                <Check size={13} weight="bold" />
                review posted
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="relative px-3 py-4 font-mono text-[0.8rem] leading-relaxed sm:text-[0.84rem]">
        {/* Scan sweep communicates the model reading top to bottom. */}
        {!reduce && phase === "reading" && (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-3 top-3 h-9 rounded-md bg-gradient-to-b from-accent/0 via-accent/10 to-accent/0"
            initial={{ y: 0, opacity: 0 }}
            animate={{ y: [0, 132, 0], opacity: [0, 1, 0] }}
            transition={{ duration: 2.2, ease: "easeInOut" }}
          />
        )}
        {DIFF.map((line) => (
          <div
            key={line.n}
            className={cn(
              "flex items-center gap-3 rounded px-2 py-0.5",
              KIND_STYLE[line.kind],
              line.focus && phase === "found" && "ring-1 ring-inset ring-accent/40",
            )}
          >
            <span className="w-6 shrink-0 select-none text-right text-fg-dim/70">{line.n}</span>
            <span className="w-3 shrink-0 select-none text-fg-dim/70">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
            </span>
            <span className="truncate">{line.text}</span>
          </div>
        ))}

        <AnimatePresence>
          {phase === "found" && (
            <motion.div
              initial={{ opacity: 0, y: reduce ? 0 : 10, height: reduce ? "auto" : 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="mt-3 overflow-hidden"
            >
              <div className="rounded-lg border border-line-hi bg-surface px-3.5 py-3 font-sans">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-warn/15 px-1.5 py-0.5 font-mono text-[0.68rem] font-semibold text-warn">
                    P2
                  </span>
                  <span className="mono-caption">src/agentWork/review.ts:42</span>
                </div>
                <p className="mt-2 text-[0.82rem] leading-relaxed text-fg-muted">
                  MAX is unset when the env var is missing, so this quietly reviews zero files.
                  Import a default from settings instead of reading it raw.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-4 border-t border-line bg-surface/40 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Circle size={9} weight="fill" className="text-warn" />1 to look at
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Check size={13} weight="bold" className="text-accent" />0 blocking
        </span>
        <span className="mono-caption ml-auto hidden sm:inline">general review</span>
      </div>
    </div>
  );
}
