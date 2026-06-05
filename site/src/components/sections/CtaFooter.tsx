import { ArrowRight, GithubLogo } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Mark } from "@/components/Mark";
import { Reveal } from "@/components/motion/Reveal";
import { NAV_LINKS, GITHUB_URL } from "@/content";

export function CtaFooter() {
  const reduce = useReducedMotion();

  return (
    <>
      <section id="start" className="relative overflow-hidden border-t border-border">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -bottom-40 mx-auto size-[560px] rounded-full bg-accent/12 blur-[150px]"
        />
        <div className="relative mx-auto max-w-[1180px] px-5 py-28 text-center sm:py-32">
          <Reveal>
            <h2 className="mx-auto max-w-[16ch] text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-fg sm:text-5xl">
              Give your next pull request a head start.
            </h2>
          </Reveal>
          <Reveal delay={0.06}>
            <p className="mx-auto mt-6 max-w-[52ch] text-pretty text-lg leading-relaxed text-fg-muted">
              Clone the repo, set a few environment variables, and run one command. Your first
              automated review can land before you finish your coffee.
            </p>
          </Reveal>
          <motion.div
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
            initial={{ opacity: 0, y: reduce ? 0 : 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <Button asChild size="lg">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
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
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-8 px-5 py-12 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-sm">
            <Mark />
            <p className="mt-4 text-sm leading-relaxed text-fg-dim">
              A self-hosted GitHub App for AI pull request reviews. Your servers, your models, your
              data.
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-8 gap-y-3" aria-label="Footer">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-fg-muted transition-colors hover:text-fg"
              >
                {link.label}
              </a>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fg-muted transition-colors hover:text-fg"
            >
              GitHub
            </a>
          </nav>
        </div>
        <div className="border-t border-border">
          <div className="mx-auto max-w-[1180px] px-5 py-6 text-sm text-fg-dim">
            Built for teams who would rather host their own tools.
          </div>
        </div>
      </footer>
    </>
  );
}
