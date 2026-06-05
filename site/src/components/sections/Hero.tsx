import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, GithubLogo, GitBranch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Magnetic } from "@/components/motion/Magnetic";
import { ReviewDemo } from "@/components/demos/ReviewDemo";
import { GITHUB_URL } from "@/content";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  const reduce = useReducedMotion();
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: reduce ? 0 : 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.75, delay, ease: EASE },
  });

  return (
    <section id="top" className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-48 right-[-10%] size-[680px] rounded-full bg-accent/10 blur-[150px]"
      />

      <div className="relative mx-auto grid max-w-[1180px] grid-cols-1 items-center gap-14 px-5 pb-20 pt-28 md:pt-32 lg:grid-cols-[1.04fr_1fr] lg:gap-12 lg:pb-28">
        <div className="max-w-xl">
          <motion.div {...rise(0)}>
            <Badge>
              <GithubLogo size={14} weight="fill" />
              Open source GitHub App
            </Badge>
          </motion.div>

          <motion.h1
            className="mt-6 text-balance text-[2.7rem] font-semibold leading-[1.03] tracking-tight text-fg sm:text-[3.4rem] lg:text-6xl"
            {...rise(0.06)}
          >
            Every pull request, <span className="text-accent">reviewed</span> in minutes.
          </motion.h1>

          <motion.p
            className="mt-6 max-w-[42ch] text-pretty text-lg leading-relaxed text-fg-muted"
            {...rise(0.13)}
          >
            PR Agent is a self-hosted GitHub App. It reviews changes, writes descriptions, and
            answers questions, all on your own machines.
          </motion.p>

          <motion.div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center" {...rise(0.2)}>
            <Magnetic>
              <Button asChild size="lg">
                <a href="#start">
                  Get started
                  <ArrowRight size={18} weight="bold" />
                </a>
              </Button>
            </Magnetic>
            <Button asChild variant="secondary" size="lg">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                View on GitHub
              </a>
            </Button>
          </motion.div>
        </div>

        <motion.div
          className="relative"
          initial={{ opacity: 0, y: reduce ? 0 : 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.18, ease: EASE }}
        >
          <div className="mb-3 flex items-center gap-2 pl-1">
            <GitBranch size={14} className="text-fg-dim" />
            <span className="mono-caption">feat/paginate-changed-files</span>
          </div>
          <ReviewDemo />
        </motion.div>
      </div>
    </section>
  );
}
