import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="relative overflow-hidden px-4 pt-16 pb-0 sm:px-6 sm:pt-20 md:pt-24">
      <div className="relative z-10 mx-auto max-w-6xl">
        <p className="max-w-md text-lg leading-snug text-ink-soft sm:text-xl">
          Stop renting your code review. Own it.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-ink-mute">
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-ink"
          >
            license
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-ink"
          >
            github
          </a>
          <a href="#usage" className="transition-colors hover:text-ink">
            deploy
          </a>
        </div>
      </div>

      <p
        className="relative z-10 mx-auto mt-16 max-w-6xl overflow-hidden pb-0 font-display text-[clamp(4.5rem,18vw,12rem)] leading-[0.78] tracking-[-0.04em] text-ink/[0.14] select-none sm:mt-20"
        aria-hidden="true"
      >
        <span className="block translate-y-[28%]">{PRODUCT_NAME}</span>
      </p>
    </footer>
  );
}
