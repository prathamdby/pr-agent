import { DiffField } from "@/components/diff-field";
import { OutboundArrow } from "@/components/icons";
import { ReviewArtifact } from "@/components/review-artifact";
import { DOCS_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="grain relative flex min-h-[100svh] flex-col overflow-hidden px-4 pt-28 sm:px-6 sm:pt-32"
    >
      <DiffField />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col pb-12 sm:pb-16">
        <div className="relative min-h-[18rem] flex-1 sm:min-h-[22rem]">
          <p className="relative z-20 max-w-[10ch] font-display text-[clamp(4.25rem,14vw,9rem)] leading-[0.85] tracking-[-0.03em] text-ink">
            {PRODUCT_NAME}
          </p>

          <div className="relative z-10 mt-8 w-full max-w-md sm:absolute sm:bottom-2 sm:right-0 sm:mt-0 sm:w-[min(92%,34rem)] lg:w-[36rem] lg:translate-x-4">
            <div
              className="[mask-image:linear-gradient(to_bottom,black_0%,black_72%,transparent_100%)]"
              style={{ WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 72%, transparent 100%)" }}
            >
              <ReviewArtifact />
            </div>
          </div>
        </div>

        <div className="relative z-20 mt-10 grid gap-6 border-t border-edge pt-8 sm:mt-auto sm:grid-cols-[minmax(0,1.4fr)_auto] sm:items-end">
          <div>
            <h1
              id="hero-heading"
              className="max-w-[28ch] font-display text-[clamp(1.45rem,2.8vw,2rem)] leading-[1.2] text-ink-soft"
            >
              AI reviews your pull requests on{" "}
              <span className="text-moss-glow">your own servers</span>
            </h1>
            <p className="mt-3 max-w-[42ch] text-sm leading-relaxed text-ink-mute sm:text-base">
              Same first pass every PR gets, without a per-seat bill. Your
              infrastructure, your model keys, your code never leaves.
            </p>
          </div>

          <div className="sm:justify-self-end sm:text-right">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 bg-ink px-5 py-3 text-sm font-medium text-forge transition-colors hover:bg-moss-glow"
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
