import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type IconSwapProps = {
  /** Which icon is showing. Changing it cross-fades to the other. */
  readonly state: string;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * Contextual icon swap. The entering icon scales from 0.25 with a 4px blur, the exiting one
 * reverses, on a bounce-free spring. `initial={false}` keeps the first render still.
 */
export function IconSwap({ state, children, className }: IconSwapProps) {
  const reduce = useReducedMotion();
  return (
    <span className={`relative inline-grid place-items-center ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={state}
          className="inline-grid place-items-center"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
