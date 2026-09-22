import { createFileRoute } from "@tanstack/react-router";
import { Check } from "@/components/icons";
import { PrWindow } from "@/components/pr-window";
import { HERO_HEADING } from "@/lib/content";
import { PRODUCT_NAME } from "@/lib/seo";

/*
  Social card, rendered from the same components as the page and screenshotted at 1200×630.
  Not linked from anywhere and marked noindex; it exists only to be photographed.
*/
export const Route = createFileRoute("/og")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: OgCard,
});

const TAGLINE = HERO_HEADING.slice(HERO_HEADING.indexOf(": ") + 2);

const POINTS = ["MIT licensed", "No per-seat fee", "Your own model keys"] as const;

function OgCard() {
  return (
    <div className="relative h-[630px] w-[1200px] overflow-hidden bg-surface text-text">
      <div className="relative z-10 flex h-full w-[600px] flex-col justify-center pl-16">
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt=""
            width={44}
            height={44}
            className="size-11 rounded-md outline-none"
          />
          <span className="text-2xl font-semibold tracking-[-0.01em]">{PRODUCT_NAME}</span>
        </div>
        <h1 className="mt-9 max-w-[9ch] text-[64px] leading-[1.04] font-medium tracking-[-0.035em]">
          {TAGLINE}
        </h1>
        <p className="mt-6 max-w-[26ch] text-[22px] leading-relaxed text-text-secondary">
          Same first pass every pull request gets, without a per-seat bill.
        </p>
        <ul className="mt-8 flex flex-wrap gap-2.5">
          {POINTS.map((point) => (
            <li
              key={point}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-surface pr-4 pl-3 text-[15px] text-text-secondary shadow-soft"
            >
              <Check className="size-4 text-accent-text" />
              {point}
            </li>
          ))}
        </ul>
      </div>

      <div className="wash wash-grid wash-clouds absolute top-10 -right-14 -bottom-16 left-[640px] rounded-xl shadow-soft">
        <div className="absolute top-10 left-10 w-[640px]">
          <PrWindow />
        </div>
      </div>
    </div>
  );
}
