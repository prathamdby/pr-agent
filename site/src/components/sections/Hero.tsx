import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, GithubLogo } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Frame } from "@/components/Frame";
import { GITHUB_URL } from "@/content";

export function Hero() {
  const reduce = useReducedMotion();

  return (
    <section id="top" className="relative overflow-hidden">
      {/* Quiet accent wash, kept to a single hue. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-grid-faint [mask-image:radial-gradient(80%_60%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-accent/12 blur-[140px]"
      />

      <div className="relative mx-auto grid max-w-[1180px] grid-cols-1 items-center gap-14 px-5 pb-20 pt-28 md:pt-36 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-28">
        <div className="max-w-xl">
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <Badge>
              <span className="size-1.5 rounded-full bg-accent" />
              Self-hosted GitHub App
            </Badge>
          </motion.div>

          <motion.h1
            className="mt-6 text-balance text-[2.6rem] font-semibold leading-[1.04] tracking-tight text-fg sm:text-5xl lg:text-6xl"
            initial={{ opacity: 0, y: reduce ? 0 : 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05, ease: [0.22, 0.61, 0.36, 1] }}
          >
            A <span className="text-accent">careful</span> reviewer for every pull request.
          </motion.h1>

          <motion.p
            className="mt-6 max-w-[34ch] text-pretty text-lg leading-relaxed text-fg-muted sm:max-w-[46ch]"
            initial={{ opacity: 0, y: reduce ? 0 : 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.12, ease: [0.22, 0.61, 0.36, 1] }}
          >
            PR Agent is a self-hosted GitHub App that reviews your changes, writes clear
            descriptions, and answers questions about the code.
          </motion.p>

          <motion.div
            className="mt-9 flex flex-col gap-3 sm:flex-row"
            initial={{ opacity: 0, y: reduce ? 0 : 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.19, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <Button asChild size="lg">
              <a href="#start">
                Get started
                <ArrowRight size={18} weight="bold" />
              </a>
            </Button>
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
          initial={{ opacity: 0, y: reduce ? 0 : 28, scale: reduce ? 1 : 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
        >
          <Frame
            label="github.com/your-org/your-repo/pull/482"
            src="/shots/review.png"
            alt="A PR Agent review summary posted on a GitHub pull request"
            status={
              <span
                className="t-shimmer font-mono text-xs"
                data-text="Reviewing changes"
                aria-label="Reviewing changes"
              >
                Reviewing changes
              </span>
            }
          />
        </motion.div>
      </div>
    </section>
  );
}
