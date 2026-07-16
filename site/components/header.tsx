import { Link } from "@tanstack/react-router";
import { OutboundArrow } from "@/components/icons";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

const NAV = [
  { href: "#examples", label: "examples", external: false, hideBelow: "md" as const },
  { href: "#pricing", label: "pricing", external: false, hideBelow: "md" as const },
  { href: DOCS_URL, label: "docs", external: true, hideBelow: "sm" as const },
  { href: REPO_URL, label: "github", external: true, hideBelow: "sm" as const },
] as const;

function navVisibility(hideBelow: "sm" | "md"): string {
  switch (hideBelow) {
    case "sm":
      return "hidden sm:inline";
    case "md":
      return "hidden md:inline";
    default: {
      const _exhaustive: never = hideBelow;
      return _exhaustive;
    }
  }
}

export function Header() {
  return (
    <header className="animate-nav-settle absolute inset-x-0 top-0 z-40 px-4 pt-5 sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <Link
          to="/"
          className="group flex min-w-0 items-center gap-2.5 text-ink"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img src="/logo.png" alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md" />
          <span className="truncate font-display text-lg tracking-wide text-ink transition-colors group-hover:text-bolt">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav
          className="surface-panel edge-self flex max-w-full items-center gap-0.5 rounded-full px-1.5 py-1 text-sm sm:px-2.5 sm:py-1.5"
          aria-label="Primary navigation"
        >
          {NAV.map((item) => {
            const className = `${navVisibility(item.hideBelow)} rounded-full px-2 py-1.5 text-ink-mute transition-colors hover:text-ink sm:px-2.5`;
            return item.external ? (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
              >
                {item.label}
              </a>
            ) : (
              <a key={item.label} href={item.href} className={className}>
                {item.label}
              </a>
            );
          })}
          <a
            href="#usage"
            className="group inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-sm text-navy transition-colors hover:bg-bolt"
          >
            deploy
            <OutboundArrow className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </nav>
      </div>
    </header>
  );
}
