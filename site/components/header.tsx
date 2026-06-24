import { Link } from "@tanstack/react-router";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";
import { ThemeToggle } from "@/components/themeToggle";

export function Header() {
  return (
    <header
      className="sticky top-0 z-50 backdrop-blur-xl bg-background-primary/80"
      style={{ boxShadow: "var(--shadow-navbar-bg)" }}
    >
      <div className="grid-layout">
        <div className="grid-layout-inner flex items-center justify-between py-3.5">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-foreground-primary"
            aria-label={`${PRODUCT_NAME} home`}
          >
            <img
              src="/logo.png"
              alt={`${PRODUCT_NAME} logo`}
              width={32}
              height={32}
              className="rounded-[10px]"
            />
            <span className="font-semibold tracking-tight">{PRODUCT_NAME}</span>
          </Link>

          <nav className="flex items-center gap-1.5 text-sm" aria-label="Primary navigation">
            <a
              href="#examples"
              className="hidden sm:inline-flex items-center rounded-full px-3 py-1.5 text-foreground-secondary hover:text-foreground-primary hover:bg-background-tertiary transition-colors duration-200"
              style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
            >
              examples
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full px-3 py-1.5 text-foreground-secondary hover:text-foreground-primary hover:bg-background-tertiary transition-colors duration-200"
              style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
            >
              docs
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full px-3 py-1.5 text-foreground-secondary hover:text-foreground-primary hover:bg-background-tertiary transition-colors duration-200"
              style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
            >
              github
            </a>
            <ThemeToggle />
            <a
              href="#usage"
              className="inline-flex items-center rounded-full bg-foreground-primary px-4 py-1.5 text-sm font-medium text-background-primary hover:opacity-90 transition-opacity duration-200"
              style={{
                boxShadow: "var(--shadow-button-sm)",
                transitionTimingFunction: "var(--ease-out-soft)",
              }}
            >
              get started
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
