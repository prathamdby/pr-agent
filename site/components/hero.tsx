import { GithubWindow } from "@/components/gh/github-window";
import { GithubPhoneMock } from "@/components/gh/phone-mock";
import { HeroDither } from "@/components/hero/hero-dither";
import { InstallCommand } from "@/components/hero/install-command";
import { GithubMark } from "@/components/ui/github-mark";
import { Reveal, RevealItem } from "@/components/ui/reveal";
import { HERO_HEADING, INSTALL_COMMAND } from "@/lib/content";
import { REPO_URL } from "@/lib/site";

/*
  Layout after the kimaki website hero (github.com/remorses/kimaki): headline and install
  command up top, product below, dithered dot field full-bleed behind both. Their Discord
  playground slot holds an interactive GitHub pull request window.
*/
export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="overflow-x-clip">
      <div className="page-wrap relative isolate mb-16 mt-10 min-w-0 sm:mb-20 lg:mb-28 lg:mt-16">
        <HeroDither offsetX={-90} />

        <div className="relative z-[2] flex min-w-0 flex-col gap-10 lg:gap-14">
          <Reveal
            onMount
            className="flex min-w-0 flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between"
          >
            <RevealItem className="min-w-0">
              <h1
                id="hero-heading"
                className="max-w-[min(14ch,100%)] text-[length:var(--text-display)] font-semibold leading-[1.02] tracking-[-0.03em] text-fg"
              >
                <span className="sr-only">{HERO_HEADING}</span>
                <span aria-hidden="true">
                  AI pull request reviews on <span className="text-accent-ink">your own</span>{" "}
                  servers.
                </span>
              </h1>
            </RevealItem>
            <RevealItem className="flex min-w-0 max-w-full shrink-0 flex-col items-start lg:items-end">
              <InstallCommand command={INSTALL_COMMAND} />
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 lg:justify-end">
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-muted flex min-h-10 items-center gap-1.5 font-mono text-[13px] text-fg-muted transition-colors duration-150"
                >
                  <GithubMark className="size-3.5" />
                  GitHub
                </a>
                <a
                  href="#install"
                  className="link-muted flex min-h-10 items-center gap-1.5 font-mono text-[13px] text-fg-muted transition-colors duration-150"
                >
                  Installation
                </a>
              </div>
            </RevealItem>
          </Reveal>

          <Reveal onMount className="min-w-0">
            <RevealItem className="min-w-0">
              <GithubPhoneMock />
              <div className="hidden min-w-0 md:block">
                <GithubWindow />
              </div>
            </RevealItem>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
