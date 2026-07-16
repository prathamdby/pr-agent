import { Link } from "@tanstack/react-router";
import { OutboundArrow } from "@/components/icons";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

const NAV = [
  { href: "#examples", label: "examples", external: false },
  { href: "#pricing", label: "pricing", external: false },
  { href: DOCS_URL, label: "docs", external: true },
  { href: REPO_URL, label: "github", external: true },
] as const;

export function Header() {
  return (
    <header className="animate-nav-settle absolute inset-x-0 top-0 z-40 px-4 pt-5 sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <Link
          to="/"
          className="group flex items-center gap-2.5 text-ink"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7"
          />
          <span className="font-display text-lg tracking-wide text-ink transition-colors group-hover:text-moss-glow">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav
          className="surface-panel edge-self flex items-center gap-1 rounded-full px-2 py-1.5 text-sm sm:gap-0.5 sm:px-2.5"
          aria-label="Primary navigation"
        >
          {NAV.map((item) =>
            item.external ? (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden rounded-full px-2.5 py-1.5 text-ink-mute transition-colors hover:text-ink sm:inline"
              >
                {item.label}
              </a>
            ) : (
              <a
                key={item.label}
                href={item.href}
                className="hidden rounded-full px-2.5 py-1.5 text-ink-mute transition-colors hover:text-ink sm:inline"
              >
                {item.label}
              </a>
            ),
          )}
          <a
            href="#usage"
            className="group inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-sm text-forge transition-colors hover:bg-moss-glow"
          >
            deploy
            <OutboundArrow className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </nav>
      </div>
    </header>
  );
}
