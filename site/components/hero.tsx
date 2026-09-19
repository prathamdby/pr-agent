import { GithubWindow } from "@/components/gh/github-window";
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
    <section aria-labelledby="hero-heading" className="px-5 sm:px-8">
      <div className="relative isolate mx-auto mb-20 mt-12 w-full max-w-[1200px] lg:mb-28 lg:mt-16">
        <HeroDither offsetX={-90} />

        <div className="relative z-[2] flex flex-col gap-12 lg:gap-14">
          <Reveal
            onMount
            className="flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between"
          >
            <RevealItem>
              <h1
                id="hero-heading"
                className="max-w-[14ch] text-[2.75rem] font-semibold leading-[1.02] tracking-[-0.03em] text-fg sm:text-6xl lg:text-7xl"
              >
                <span className="sr-only">{HERO_HEADING}</span>
                <span aria-hidden="true">
                  AI pull request reviews on <span className="text-accent-ink">your own</span>{" "}
                  servers.
                </span>
              </h1>
            </RevealItem>
            <RevealItem className="flex shrink-0 flex-col items-start lg:items-end">
              <InstallCommand command={INSTALL_COMMAND} />
              <div className="mt-4 flex items-center gap-5 lg:justify-end">
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-muted flex items-center gap-1.5 font-mono text-[13px] text-fg-muted transition-colors duration-150"
                >
                  <GithubMark className="size-3.5" />
                  GitHub
                </a>
                <a
                  href="#install"
                  className="link-muted flex items-center gap-1.5 font-mono text-[13px] text-fg-muted transition-colors duration-150"
                >
                  Installation
                </a>
              </div>
            </RevealItem>
          </Reveal>

          <Reveal onMount>
            <RevealItem>
              <GithubWindow />
            </RevealItem>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
