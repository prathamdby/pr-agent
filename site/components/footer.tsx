import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="relative overflow-hidden px-4 pt-20 sm:px-6 sm:pt-28">
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
        className="relative z-10 mx-auto mt-20 max-w-6xl overflow-hidden font-display text-[clamp(4.5rem,18vw,12rem)] leading-[0.82] tracking-[-0.04em] text-ink/[0.12] select-none"
        aria-hidden="true"
      >
        <span className="block translate-y-[22%]">{PRODUCT_NAME}</span>
      </p>
    </footer>
  );
}
