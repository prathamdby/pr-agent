import { DiffField } from "@/components/diff-field";
import { OutboundArrow } from "@/components/icons";
import { ReviewArtifact } from "@/components/review-artifact";
import { FEATURES, HERO_CTA_NOTE, HERO_HEADING, HERO_SUPPORT, SLASH_COMMANDS } from "@/lib/content";
import { PRODUCT_NAME } from "@/lib/seo";
import { DOCS_URL } from "@/lib/site";

export function Opening() {
  return (
    <section aria-labelledby="hero-heading" className="grain relative overflow-x-hidden">
      <h1 id="hero-heading" className="sr-only">
        {HERO_HEADING}
      </h1>
      <DiffField />

      <div className="relative z-10 mx-auto max-w-6xl px-4 pt-24 pb-8 sm:px-6 sm:pt-28 sm:pb-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
          <div className="min-w-0">
            <p className="font-display text-[clamp(2.15rem,4.5vw,3.25rem)] leading-none tracking-[-0.03em] text-ink">
              {PRODUCT_NAME}
            </p>
            <p className="mt-2 max-w-[46ch] text-sm leading-snug text-ink-soft sm:text-[0.95rem]">
              {HERO_SUPPORT}
            </p>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.75rem] text-bolt">
              {SLASH_COMMANDS.map((item) => (
                <span key={item.cmd}>{item.cmd}</span>
              ))}
            </p>
          </div>

          <div className="shrink-0 sm:text-right">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 bg-ink px-4 py-2.5 text-sm font-medium text-navy transition-colors hover:bg-bolt hover:text-navy"
            >
              Deploy from the README
              <OutboundArrow className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
            <p className="mt-2 text-xs text-ink-mute">{HERO_CTA_NOTE}</p>
          </div>
        </div>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)] lg:gap-10">
          <ReviewArtifact />
          <ol id="features" className="space-y-3">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <p className="text-sm font-medium leading-snug text-ink">{feature.title}</p>
                <p className="mt-0.5 text-sm leading-snug text-ink-mute">{feature.summary}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
