import { ButtonLink } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { ArrowUpRight, ChevronRight, Star } from "@/components/icons";
import { PrWindow } from "@/components/pr-window";
import { ClaudeMark, GeminiMark, OpenAiMark } from "@/components/provider-logos";
import { renderSetupPrompt } from "@/lib/agentResources";
import { HERO_CTA_NOTE, HERO_HEADING, HERO_HEADING_PILL, HERO_SUPPORT } from "@/lib/content";
import { REPO_URL, SITE_ORIGIN } from "@/lib/site";

const SEPARATOR = ": ";
const SPLIT = HERO_HEADING.indexOf(SEPARATOR);
const HERO_BRAND = HERO_HEADING.slice(0, SPLIT);
const HERO_TAGLINE = HERO_HEADING.slice(SPLIT + SEPARATOR.length);
const PILL_AT = HERO_TAGLINE.indexOf(HERO_HEADING_PILL);
const HERO_LEAD = HERO_TAGLINE.slice(0, PILL_AT).trimEnd();
const HERO_TAIL = HERO_TAGLINE.slice(PILL_AT + HERO_HEADING_PILL.length).trimStart();

function setupPrompt(): string {
  return renderSetupPrompt(typeof window === "undefined" ? SITE_ORIGIN : window.location.origin);
}

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
    <section aria-labelledby="hero-heading" className="sky-rise">
      <div className="container-x flex flex-col items-center pt-10 text-center sm:pt-16">
        <div className="flex flex-col items-center motion-safe:animate-rise">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-2 rounded-full bg-surface pr-3 pl-1.5 text-label whitespace-nowrap text-text-secondary shadow-soft transition-[color,scale] duration-[150ms,200ms] ease-out hover:text-text active:scale-[0.97] motion-reduce:transition-none"
          >
            <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-accent-text">
              <Star className="size-3" />
            </span>
            Star PR Agent on GitHub
            <ArrowUpRight className="size-3.5 text-text-tertiary" />
          </a>
          <h1
            id="hero-heading"
            className="mt-6 max-w-75 text-[clamp(2.5rem,5.6vw,4.75rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text sm:max-w-245"
          >
            <span className="sr-only">{HERO_BRAND}: </span>
            <span className="sm:block">{HERO_LEAD}</span>{" "}
            <span className="word-pill sky-tint shadow-soft max-sm:mx-auto max-sm:my-2.5 max-sm:flex max-sm:w-fit">
              <span className="word-pill-avatar bg-surface shadow-soft">
                <img src="/logo.png" alt="" width={48} height={48} className="outline-none" />
              </span>
              <span className="self-baseline">{HERO_HEADING_PILL}</span>
            </span>{" "}
            {HERO_TAIL}
          </h1>
        </div>

        <div className="flex w-full flex-col items-center motion-safe:animate-rise motion-safe:[animation-delay:90ms]">
          <p className="mt-6 max-w-155 text-base leading-relaxed text-text-secondary sm:text-lg">
            {HERO_SUPPORT}
          </p>
          <div className="mt-8 grid w-full gap-3 sm:flex sm:w-auto sm:justify-center">
            <ButtonLink href="#usage" trailingIcon={<ChevronRight className="size-4" />}>
              Deploy yourself
            </ButtonLink>
            <CopyButton
              text={setupPrompt()}
              label="Copy prompt"
              variant="secondary"
              iconAfter
              prefix={<AssistantMarks />}
            />
          </div>
          <p className="mt-4 text-label text-text-tertiary">{HERO_CTA_NOTE}</p>
        </div>

        <div className="relative mt-14 h-95 w-full text-left motion-safe:animate-rise motion-safe:[animation-delay:180ms] sm:h-110 lg:h-125">
          <div className="absolute inset-x-0 top-0 mx-auto max-w-220">
            <PrWindow />
          </div>
        </div>
      </div>
    </section>
  );
}
