import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check } from "@phosphor-icons/react";

const SERVICES = [
  { name: "postgres", detail: "stores every event" },
  { name: "web", detail: "accepts webhooks on :7224" },
  { name: "worker", detail: "reviews, descriptions, asks" },
];

export function DeploySequence() {
  const reduce = useReducedMotion();
  const [ready, setReady] = useState(reduce ? SERVICES.length : 0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started || reduce) return;
    if (ready >= SERVICES.length) return;
    const t = setTimeout(() => setReady((r) => r + 1), 720);
    return () => clearTimeout(t);
  }, [started, ready, reduce]);

  const done = ready >= SERVICES.length;

  return (
    <motion.div
      onViewportEnter={() => setStarted(true)}
      viewport={{ once: true, amount: 0.6 }}
      className="rounded-[var(--radius)] border border-line-hi bg-bg-soft p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-center gap-2 border-b border-line pb-4">
        <span className="font-mono text-sm text-fg">docker compose up</span>
        <span className="mono-caption ml-auto">{done ? "3/3 healthy" : `${ready}/3`}</span>
      </div>

      <ul className="mt-4 space-y-3">
        {SERVICES.map((svc, i) => {
          const isReady = i < ready;
          const isStarting = i === ready && started && !reduce;
          return (
            <li key={svc.name} className="flex items-center gap-3">
              <span className="flex size-6 items-center justify-center">
                {isReady ? (
                  <motion.span
                    initial={reduce ? false : { scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 420, damping: 20 }}
                    className="flex size-6 items-center justify-center rounded-full bg-accent/15"
                  >
                    <Check size={13} weight="bold" className="text-accent" />
                  </motion.span>
                ) : isStarting ? (
                  <motion.span
                    className="size-2.5 rounded-full bg-accent"
                    animate={{ opacity: [1, 0.25, 1] }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
                  />
                ) : (
                  <span className="size-2.5 rounded-full border border-line-hi" />
                )}
              </span>
              <span
                className={
                  isReady ? "font-mono text-sm text-fg" : "font-mono text-sm text-fg-dim"
                }
              >
                {svc.name}
              </span>
              <span className="mono-caption ml-auto text-right">{svc.detail}</span>
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}
