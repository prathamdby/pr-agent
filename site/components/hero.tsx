import { DiffField } from "@/components/diff-field";
import { OutboundArrow } from "@/components/icons";
import { ReviewArtifact } from "@/components/review-artifact";
import { DOCS_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

/**
 * Hero owns the fold as ONE composed block (brand + artifact + band),
 * vertically centered as a unit. Never stretch pieces apart with flex-1 —
 * that leaves a dead middle on tall tablets (iPad Air).
 */
export function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="grain relative flex min-h-[100svh] flex-col justify-center overflow-hidden px-4 pb-12 pt-28 sm:px-6 sm:pb-16 sm:pt-32"
    >
      <DiffField />

      <div className="relative z-10 mx-auto w-full min-w-0 max-w-6xl">
        {/*
          md+ min-height reserves space for the absolutely placed artifact so the
          copy band below cannot slide up underneath it.
        */}
        <div className="relative md:min-h-[19rem] lg:min-h-[21rem]">
          <p className="relative z-20 max-w-[10ch] font-display text-[clamp(3.75rem,11vw,8.5rem)] leading-[0.85] tracking-[-0.03em] text-ink md:max-w-[9ch] md:text-[clamp(4.25rem,9.5vw,8rem)]">
            {PRODUCT_NAME}
          </p>

          <div className="relative z-10 mt-6 w-full max-w-sm md:absolute md:bottom-0 md:right-0 md:mt-0 md:w-[min(48%,22rem)] lg:w-[min(44%,24rem)]">
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

        <div className="relative z-20 mt-10 grid min-w-0 gap-6 border-t border-edge pt-8 md:mt-12 md:grid-cols-[minmax(0,1.35fr)_auto] md:items-end md:gap-10">
          <div className="min-w-0 md:max-w-xl">
            <h1
              id="hero-heading"
              className="max-w-[28ch] font-display text-[clamp(1.4rem,2.6vw,2rem)] leading-[1.2] text-ink-soft"
            >
              AI reviews your pull requests on{" "}
              <span className="text-bolt">your own servers</span>
            </h1>
            <p className="mt-3 max-w-[42ch] text-sm leading-relaxed text-ink-mute sm:text-base">
              Same first pass every PR gets, without a per-seat bill. Your infrastructure, your
              model keys, your code never leaves.
            </p>
          </div>

          <div className="min-w-0 md:justify-self-end md:text-right">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 bg-ink px-5 py-3 text-sm font-medium text-navy transition-colors hover:bg-bolt hover:text-navy"
            >
              Deploy from the README
              <OutboundArrow className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
            <p className="mt-3 text-xs text-ink-faint">MIT licensed. Hosting and AI usage on you.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
