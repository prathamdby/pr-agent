import { DiffField } from "@/components/diff-field";
import { OutboundArrow } from "@/components/icons";
import { ReviewArtifact } from "@/components/review-artifact";
import { DOCS_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

/**
 * One composed fold: brand + artifact in-flow, then a copy/CTA band.
 * Top-anchored until large desktop so tall tablets do not open a dead middle.
 */
export function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="grain relative flex min-h-[100svh] flex-col justify-start overflow-x-hidden px-4 pb-12 pt-28 sm:px-6 sm:pb-16 sm:pt-32 lg:justify-center"
    >
      <DiffField />

      <div className="relative z-10 mx-auto w-full min-w-0 max-w-6xl">
        <div className="grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <p className="min-w-0 font-display text-[clamp(3.25rem,14vw,5.5rem)] leading-[0.85] tracking-[-0.03em] text-ink md:text-[clamp(3.5rem,7vw,5.5rem)] lg:text-[clamp(4.5rem,9vw,8rem)]">
            {PRODUCT_NAME}
          </p>

          <div className="min-w-0 w-full max-w-sm max-h-[14rem] overflow-hidden md:max-h-none md:max-w-none">
            <div
              className="[mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)] md:[mask-image:linear-gradient(to_bottom,black_0%,black_78%,transparent_100%)]"
              style={{
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
              }}
            >
              <ReviewArtifact />
            </div>
          </div>
        </div>

        <div className="relative z-20 mt-8 max-w-xl border-t border-edge pt-7 md:mt-10 md:pt-8">
          <h1
            id="hero-heading"
            className="max-w-[28ch] font-display text-[clamp(1.35rem,2.6vw,2rem)] leading-[1.2] text-ink-soft"
          >
            AI reviews your pull requests on{" "}
            <span className="text-bolt">your own servers</span>
          </h1>
          <p className="mt-3 max-w-[42ch] text-sm leading-relaxed text-ink-mute sm:text-base">
            Same first pass every PR gets, without a per-seat bill. Your infrastructure, your model
            keys, your code never leaves.
          </p>
          <div className="mt-6">
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
