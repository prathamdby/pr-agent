import { motion, useReducedMotion, type Variants } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

const EASE = [0.23, 1, 0.32, 1] as const;

const group: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.1 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.4, ease: EASE } },
};

type RevealProps = {
  readonly children: ReactNode;
  readonly className?: string;
  /** Play on mount instead of waiting for the viewport. Use for the hero only. */
  readonly onMount?: boolean;
  readonly as?: "div" | "ul" | "ol" | "dl" | "section" | "header";
  readonly "aria-label"?: string;
};

/**
 * Group reveal in small batches. Children wrapped in `RevealItem` fade and rise in sequence as
 * the group enters the viewport. Under reduced motion everything renders in its final state.
 */
export function Reveal({
  children,
  className,
  onMount = false,
  as = "div",
  "aria-label": ariaLabel,
}: RevealProps) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  if (reduce) {
    const Plain = as;
    return (
      <Plain className={className} aria-label={ariaLabel}>
        {children}
      </Plain>
    );
  }
  return (
    <Tag
      className={className}
      aria-label={ariaLabel}
      variants={group}
      initial="hidden"
      {...(onMount
        ? { animate: "shown" }
        : { whileInView: "shown", viewport: { once: true, amount: 0.25 } })}
    >
      {children}
    </Tag>
  );
}

type RevealItemProps = {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly as?: "div" | "li" | "p" | "h1" | "h2" | "h3" | "figure";
};

export function RevealItem({ children, className, style, as = "div" }: RevealItemProps) {
  const reduce = useReducedMotion();
  if (reduce) {
    const Plain = as;
    return (
      <Plain className={className} style={style}>
        {children}
      </Plain>
    );
  }
  const Tag = motion[as];
  return (
    <Tag className={className} style={style} variants={item}>
      {children}
    </Tag>
  );
}
