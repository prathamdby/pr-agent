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

function HeroCta() {
  return (
    <div>
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

      <div className="relative z-10 mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-6 px-4 pb-10 pt-28 sm:px-6 sm:pb-12 sm:pt-32 md:grid-cols-2 md:gap-8 md:pb-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)] lg:items-stretch lg:gap-x-12 lg:gap-y-8 lg:pb-16">
        <p className="min-w-0 font-display text-[clamp(3.25rem,10vw,8rem)] leading-[0.85] tracking-[-0.03em] text-ink">
          {PRODUCT_NAME}
        </p>

        <div className="min-w-0 w-full max-h-[14rem] overflow-hidden md:col-start-2 md:row-span-2 md:row-start-1 md:max-h-none md:self-stretch">
          <div className="h-full [mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)] md:[mask-image:none] md:[-webkit-mask-image:none]">
            <ReviewArtifact />
          </div>
        </div>

        <div className="min-w-0 border-t border-edge pt-7 md:col-start-1 md:pt-8">
          <HeroCopy />
          <div className="mt-6">
            <HeroCta />
          </div>
        </div>
      </div>
    </section>
  );
}
