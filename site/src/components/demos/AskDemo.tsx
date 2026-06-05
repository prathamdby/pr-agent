import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowBendDownRight, Check } from "@phosphor-icons/react";

type Phase = "idle" | "asked" | "thinking" | "answered";

const ANSWER =
  "No. timingSafeEqual throws when the two buffers differ in length, so guard the length first, then compare against the digest you computed.";

export function AskDemo() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    if (phase !== "asked") return;
    const t1 = setTimeout(() => setPhase("thinking"), reduce ? 0 : 600);
    const t2 = setTimeout(() => setPhase("answered"), reduce ? 0 : 1900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [phase, reduce]);

  return (
    <motion.div
      onViewportEnter={() => setPhase((p) => (p === "idle" ? "asked" : p))}
      viewport={{ once: true, amount: 0.5 }}
      className="flex h-full flex-col justify-center gap-3"
    >
      <div className="flex items-center gap-2">
        <ArrowBendDownRight size={15} className="text-fg-dim" />
        <span className="mono-caption">src/webhooks/verify.ts:18</span>
      </div>

      <div className="rounded-lg rounded-tl-sm border border-line-hi bg-surface px-3.5 py-2.5 text-sm text-fg">
        Is this still constant time if the lengths do not match?
      </div>

      <div className="min-h-[4.5rem]">
        <AnimatePresence mode="wait">
          {phase === "thinking" && (
            <motion.div
              key="thinking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1.5 pl-1 pt-2"
            >
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="size-1.5 rounded-full bg-fg-dim"
                  animate={reduce ? {} : { opacity: [0.3, 1, 0.3] }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    delay: i * 0.18,
                    ease: "easeInOut",
                  }}
                />
              ))}
            </motion.div>
          )}
          {phase === "answered" && (
            <motion.div
              key="answer"
              initial={{ opacity: 0, y: reduce ? 0 : 8, filter: reduce ? "none" : "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="flex gap-2.5"
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-accent/15">
                <Check size={12} weight="bold" className="text-accent" />
              </span>
              <p className="text-sm leading-relaxed text-fg-muted">{ANSWER}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
