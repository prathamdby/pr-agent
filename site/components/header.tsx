import { Link } from "@tanstack/react-router";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-background-primary/80 backdrop-blur-md border-b border-border-line" data-line>
      <div className="grid-layout h-14 items-center">
        <div className="col-span-2 md:col-span-6 lg:col-span-12 flex items-center gap-2">
          <Link
            to="/"
            className="flex items-center gap-2 text-foreground-primary hover:text-foreground-secondary transition-colors duration-200"
            aria-label={`${PRODUCT_NAME} home`}
          >
            <div className="size-8 rounded-lg bg-brand-base flex items-center justify-center text-white text-sm font-bold">
              P
            </div>
            <span className="font-semibold text-sm">{PRODUCT_NAME}</span>
          </Link>
        </div>

        <nav
          className="col-span-2 md:col-span-6 lg:col-span-12 flex items-center justify-end gap-4 text-sm"
          aria-label="Primary navigation"
        >
          <a
            href="#examples"
            className="hidden sm:inline text-foreground-tertiary hover:text-foreground-primary transition-colors duration-200"
          >
            Examples
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground-tertiary hover:text-foreground-primary transition-colors duration-200"
          >
            Docs
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground-tertiary hover:text-foreground-primary transition-colors duration-200"
          >
            GitHub
          </a>
          <a
            href="#usage"
            className="rounded-lg bg-brand-base px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-vivid transition-colors duration-200 shadow-button-sm"
          >
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}
