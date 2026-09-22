import { ButtonLink } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { ArrowUpRight, ChevronRight, Star } from "@/components/icons";
import { PrWindow } from "@/components/pr-window";
import { ClaudeMark, GeminiMark, OpenAiMark } from "@/components/provider-logos";
import { renderSetupPrompt } from "@/lib/agentResources";
import { HERO_CTA_NOTE, HERO_HEADING, HERO_SUPPORT } from "@/lib/content";
import { REPO_URL } from "@/lib/site";

/*
  The shared heading reads "PR Agent: AI PR reviews on your own servers" so the markdown page and
  search results carry the name. On screen the name is in the header already, so only the tagline
  is visible and the brand stays in the heading for assistive tech.
*/
const SEPARATOR = ": ";
const SPLIT = HERO_HEADING.indexOf(SEPARATOR);
const HERO_BRAND = HERO_HEADING.slice(0, SPLIT);
const HERO_TAGLINE = HERO_HEADING.slice(SPLIT + SEPARATOR.length);

const SETUP_PROMPT = renderSetupPrompt();

/** Three marks stand in for "any AI tool" on the copy-prompt button. */
function AssistantMarks() {
  return (
    <span className="flex items-center gap-1 text-text-secondary" aria-hidden="true">
      <OpenAiMark className="size-3.5" />
      <ClaudeMark className="size-3.5" />
      <GeminiMark className="size-3.5" />
    </span>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="pt-10 pb-16 sm:pt-16 lg:pt-20 lg:pb-20">
      <div className="container-x grid items-center gap-12 lg:grid-cols-[minmax(0,10fr)_minmax(0,11fr)] lg:gap-10">
        <div className="max-w-xl">
          <div className="motion-safe:animate-rise">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-full bg-surface pr-3 pl-1.5 text-[13px] whitespace-nowrap text-text-secondary shadow-soft transition-[color,scale] duration-[150ms,200ms] ease-out hover:text-text active:scale-[0.97] motion-reduce:transition-none"
            >
              <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-accent-text">
                <Star className="size-3" />
              </span>
              Star PR Agent on GitHub
              <ArrowUpRight className="size-3.5 text-text-tertiary" />
            </a>
            <h1
              id="hero-heading"
              className="mt-6 text-[clamp(2.5rem,5.6vw,4.25rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text"
            >
              <span className="sr-only">{HERO_BRAND}: </span>
              {HERO_TAGLINE}
            </h1>
          </div>

          <div className="motion-safe:animate-rise motion-safe:[animation-delay:90ms]">
            <p className="mt-6 max-w-[46ch] text-base leading-relaxed text-text-secondary sm:text-lg">
              {HERO_SUPPORT}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="#usage" trailingIcon={<ChevronRight className="size-4" />}>
                Deploy yourself
              </ButtonLink>
              <CopyButton
                text={SETUP_PROMPT}
                label="Copy prompt"
                variant="secondary"
                iconAfter
                prefix={<AssistantMarks />}
              />
            </div>
            <p className="mt-4 text-[13px] text-text-tertiary">{HERO_CTA_NOTE}</p>
          </div>
        </div>

        <div className="wash wash-grid aspect-[4/3] w-full rounded-xl shadow-soft motion-safe:animate-rise motion-safe:[animation-delay:180ms] sm:aspect-[5/4] lg:aspect-auto lg:h-[36rem]">
          <div className="absolute inset-x-5 top-5 sm:inset-x-8 sm:top-8 lg:top-12 lg:right-auto lg:left-12 lg:w-[34rem]">
            <PrWindow />
          </div>
        </div>
      </div>
    </section>
  );
}
