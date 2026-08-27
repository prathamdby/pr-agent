import { DiffField } from "@/components/diff-field";
import { OutboundArrow } from "@/components/icons";
import { ReviewArtifact } from "@/components/review-artifact";
import { HERO_CTA_NOTE, HERO_HEADING, HERO_SUPPORT } from "@/lib/content";
import { DOCS_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

const heroCopyClassName =
  "max-w-[28ch] font-display text-[clamp(1.35rem,2.6vw,2rem)] leading-[1.2] text-ink-soft";

function HeroCopy() {
  return (
    <>
      <p className={heroCopyClassName} aria-hidden="true">
        AI PR reviews on <span className="text-bolt">your own servers</span>
      </p>
      <p className="mt-3 max-w-[42ch] text-sm leading-relaxed text-ink-mute sm:text-base">
        {HERO_SUPPORT}
      </p>
    </>
  );
}

function HeroCta({ align = "start" }: { readonly align?: "start" | "end" }) {
  return (
    <div className={align === "end" ? "text-right" : undefined}>
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group inline-flex items-center gap-2 rounded-md bg-ink px-5 py-3 text-sm font-medium text-navy transition-colors hover:bg-bolt hover:text-navy"
      >
        Deploy from the README
        <OutboundArrow className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </a>
      <p className="mt-3 text-xs text-ink-faint">{HERO_CTA_NOTE}</p>
    </div>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="grain relative overflow-x-hidden">
      <h1 id="hero-heading" className="sr-only">
        {HERO_HEADING}
      </h1>
      <DiffField />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 pb-10 pt-28 sm:px-6 sm:pb-12 sm:pt-32 md:pb-14 lg:hidden">
        <div className="grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:gap-8">
          <p className="min-w-0 font-display text-[clamp(3.25rem,14vw,5.5rem)] leading-[0.85] tracking-[-0.03em] text-ink md:text-[clamp(3.5rem,7vw,5.5rem)]">
            {PRODUCT_NAME}
          </p>
          <div className="min-w-0 w-full max-w-sm max-h-[14rem] overflow-hidden md:max-h-none md:max-w-none">
            <div
              className="[mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)]"
              style={{
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
              }}
            >
              <ReviewArtifact />
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-edge pt-7 md:mt-10 md:grid md:grid-cols-[minmax(0,1.4fr)_auto] md:items-end md:gap-8 md:pt-8">
          <div className="min-w-0">
            <HeroCopy />
          </div>
          <div className="mt-6 min-w-0 md:mt-0 md:justify-self-end md:text-right">
            <HeroCta />
          </div>
        </div>
      </div>

      <div className="relative z-10 mx-auto hidden min-h-[100svh] w-full max-w-6xl flex-col px-6 pb-16 pt-32 lg:flex">
        <div className="relative min-h-[22rem] flex-1">
          <p className="relative z-20 max-w-[10ch] font-display text-[clamp(4.5rem,10vw,9rem)] leading-[0.85] tracking-[-0.03em] text-ink">
            {PRODUCT_NAME}
          </p>
          <div className="absolute bottom-2 right-0 z-10 w-[44%]">
            <div
              className="[mask-image:linear-gradient(to_bottom,black_0%,black_72%,transparent_100%)]"
              style={{
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 0%, black 72%, transparent 100%)",
              }}
            >
              <ReviewArtifact />
            </div>
          </div>
        </div>

        <div className="mt-auto grid grid-cols-[minmax(0,1.4fr)_auto] items-end gap-8 border-t border-edge pt-8">
          <div className="min-w-0">
            <HeroCopy />
          </div>
          <div className="min-w-0 justify-self-end">
            <HeroCta align="end" />
          </div>
        </div>
      </div>
    </section>
  );
}
