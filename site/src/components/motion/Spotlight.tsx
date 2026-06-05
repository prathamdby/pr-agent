import { type ReactNode, useRef } from "react";
import { motion, useMotionValue, useMotionTemplate, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * A soft accent glow that follows the cursor across a surface.
 * Communicates which tile is in focus. Pointer position lives on motion values.
 */
export function Spotlight({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article" | "li";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const mx = useMotionValue(-200);
  const my = useMotionValue(-200);
  const background = useMotionTemplate`radial-gradient(280px circle at ${mx}px ${my}px, rgba(63,185,80,0.10), transparent 70%)`;

  const MotionTag = motion[Tag] as typeof motion.div;

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    if (reduce || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    mx.set(e.clientX - rect.left);
    my.set(e.clientY - rect.top);
  }

  return (
    <MotionTag
      ref={ref}
      onPointerMove={onMove}
      className={cn("group relative overflow-hidden", className)}
    >
      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background }}
      />
      {children}
    </MotionTag>
  );
}
